/// <reference types="@cloudflare/workers-types" />

import { buildAssetUrl, type AssetManifest } from "../core/AssetUrls";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  Quads,
} from "../core/game/Game";
import {
  ClientMessageSchema,
  GameInfoSchema,
  GameStartInfoSchema,
  isValidGameID,
  type ClientID,
  type ClientJoinMessage,
  type ClientMessage,
  type ClientRejoinMessage,
  type GameConfig,
  type GameID,
  type GameInfo,
  type Player,
  type PublicGameInfo,
  type PublicGames,
  type PublicGameType,
  type ServerErrorMessage,
  type ServerLobbyInfoMessage,
  type ServerPrestartMessage,
  type ServerStartGameMessage,
  type ServerTurnMessage,
  type StampedIntent,
  type Turn,
} from "../core/Schemas";
import { CreateGameInputSchema } from "../core/WorkerSchemas";

const PUBLIC_GAME_TYPES: PublicGameType[] = ["ffa", "team", "special"];
const PUBLIC_LOBBY_START_DELAY_MS = 45_000;
const PRIVATE_LOBBY_DEFAULT_START_DELAY_SECONDS = 5;
const TURN_INTERVAL_MS = 100;
const LOBBY_BROADCAST_INTERVAL_MS = 1000;
const PRESTART_TO_START_DELAY_MS = 2000;
const MAX_GAME_DURATION_MS = 3 * 60 * 60 * 1000;
const EMPTY_GAME_IDLE_TIMEOUT_MS = 60_000;

interface Env {
  ASSETS: Fetcher;
  LOBBY: DurableObjectNamespace;
  GAME: DurableObjectNamespace;
  OPENFRONT_GAME_ENV?: string;
  OPENFRONT_NUM_WORKERS?: string;
  OPENFRONT_TURNSTILE_SITE_KEY?: string;
  OPENFRONT_JWT_AUDIENCE?: string;
  OPENFRONT_INSTANCE_ID?: string;
  OPENFRONT_GIT_COMMIT?: string;
  OPENFRONT_CDN_BASE?: string;
}

interface StoredGameState {
  id: GameID;
  createdAt: number;
  visibleAt?: number;
  gameConfig: GameConfig;
  creatorPersistentID?: string;
  startsAt?: number;
  publicGameType?: PublicGameType;
  hasPrestarted: boolean;
  hasStarted: boolean;
  hasEnded: boolean;
  startTime?: number;
  lobbyCreatorID?: ClientID;
  gameStartInfo?: {
    gameID: GameID;
    lobbyCreatedAt: number;
    visibleAt?: number;
    config: GameConfig;
    players: Player[];
  };
  turns: Turn[];
  persistentIdToClientId: Record<string, ClientID>;
  allClients: Record<ClientID, StoredClient>;
}

interface StoredClient {
  clientID: ClientID;
  persistentID: string;
  username: string;
  clanTag: string | null;
  cosmetics?: ClientJoinMessage["cosmetics"];
}

interface ConnectedClient extends StoredClient {
  ws: WebSocket;
  lastPing: number;
}

interface SocketAttachment {
  clientID?: ClientID;
}

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
}

function notFound(): Response {
  return jsonResponse({ error: "Not found" }, { status: 404 });
}

function parseWorkerRoute(pathname: string): {
  workerIndex: number;
  path: string;
} | null {
  const match = pathname.match(/^\/w(\d+)(\/.*)?$/);
  if (!match) return null;
  return {
    workerIndex: Number.parseInt(match[1], 10),
    path: match[2] ?? "/",
  };
}

function isWebSocketRequest(request: Request): boolean {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

function safeSend(ws: WebSocket, payload: string): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(payload);
    return true;
  } catch {
    return false;
  }
}

function generateID(): GameID {
  const alphabet = "123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function defaultGameConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    donateGold: false,
    donateTroops: false,
    gameMap: GameMapType.World,
    gameType: GameType.Private,
    gameMapSize: GameMapSize.Normal,
    difficulty: Difficulty.Easy,
    nations: "default",
    infiniteGold: false,
    infiniteTroops: false,
    maxTimerValue: undefined,
    instantBuild: false,
    randomSpawn: false,
    gameMode: GameMode.FFA,
    bots: 400,
    disabledUnits: [],
    startDelay: PRIVATE_LOBBY_DEFAULT_START_DELAY_SECONDS,
    ...overrides,
  };
}

function publicGameConfig(type: PublicGameType): GameConfig {
  if (type === "team") {
    return defaultGameConfig({
      gameType: GameType.Public,
      gameMode: GameMode.Team,
      donateGold: true,
      donateTroops: true,
      playerTeams: Quads,
      maxPlayers: 120,
    });
  }

  if (type === "special") {
    return defaultGameConfig({
      gameType: GameType.Public,
      gameMapSize: GameMapSize.Compact,
      maxPlayers: 80,
      bots: 250,
      publicGameModifiers: {
        isCompact: true,
        isCrowded: true,
      },
    });
  }

  return defaultGameConfig({
    gameType: GameType.Public,
    maxPlayers: 120,
  });
}

function extractPersistentID(token: string): string {
  const uuidMatch = token.match(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  if (uuidMatch) return token;

  const jwtPayload = token.split(".")[1];
  if (!jwtPayload) return token;
  try {
    const normalized = jwtPayload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    const payload = JSON.parse(atob(padded)) as { sub?: unknown };
    return typeof payload.sub === "string" ? payload.sub : token;
  } catch {
    return token;
  }
}

function isHtmlNavigation(request: Request, pathname: string): boolean {
  if (request.method !== "GET") return false;
  if (isWebSocketRequest(request)) return false;
  if (pathname === "/" || pathname === "/index.html") return true;
  if (/^\/w\d+\/game\/[A-Za-z0-9]{8}$/.test(pathname)) return true;
  const accept = request.headers.get("Accept") ?? "";
  return accept.includes("text/html") && !pathname.includes(".");
}

async function fetchAssetManifest(
  env: Env,
  request: Request,
): Promise<AssetManifest> {
  const url = new URL(request.url);
  url.pathname = "/asset-manifest.json";
  const response = await env.ASSETS.fetch(new Request(url.toString(), request));
  if (!response.ok) return {};
  try {
    return (await response.json()) as AssetManifest;
  } catch {
    return {};
  }
}

async function renderAppShell(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = "/index.html";
  const response = await env.ASSETS.fetch(new Request(url.toString(), request));
  if (!response.ok) return response;

  const assetManifest = await fetchAssetManifest(env, request);
  const cdnBase = env.OPENFRONT_CDN_BASE ?? "";
  const replacements: Record<string, string> = {
    gitCommit: JSON.stringify(env.OPENFRONT_GIT_COMMIT ?? "DEV"),
    assetManifest: JSON.stringify(assetManifest),
    cdnBase: JSON.stringify(cdnBase),
    gameEnv: JSON.stringify(env.OPENFRONT_GAME_ENV ?? "dev"),
    numWorkers: JSON.stringify(Number(env.OPENFRONT_NUM_WORKERS ?? "1")),
    turnstileSiteKey: JSON.stringify(
      env.OPENFRONT_TURNSTILE_SITE_KEY ?? "1x00000000000000000000AA",
    ),
    jwtAudience: JSON.stringify(env.OPENFRONT_JWT_AUDIENCE ?? "localhost"),
    instanceId: JSON.stringify(env.OPENFRONT_INSTANCE_ID ?? "CLOUDFLARE_DEV"),
    manifestHref: buildAssetUrl("manifest.json", assetManifest, cdnBase),
    faviconHref: buildAssetUrl("images/Favicon.svg", assetManifest, cdnBase),
    gameplayScreenshotUrl: buildAssetUrl(
      "images/GameplayScreenshot.png",
      assetManifest,
      cdnBase,
    ),
    backgroundImageUrl: buildAssetUrl(
      "images/background.webp",
      assetManifest,
      cdnBase,
    ),
    desktopLogoImageUrl: buildAssetUrl(
      "images/OpenFront.png",
      assetManifest,
      cdnBase,
    ),
    mobileLogoImageUrl: buildAssetUrl("images/OF.png", assetManifest, cdnBase),
  };

  const html = (await response.text())
    .replace(/<%-\s*locals\.cdnBaseRaw\s*\|\|\s*""\s*%>/g, cdnBase)
    .replace(/<%-\s*(\w+)\s*%>/g, (_match, key: string) => {
      return replacements[key] ?? "";
    });

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control":
        "public, max-age=0, s-maxage=300, stale-while-revalidate=86400",
    },
  });
}

async function routeToGameDO(
  env: Env,
  gameID: GameID,
  request: Request,
): Promise<Response> {
  const id = env.GAME.idFromName(gameID);
  return env.GAME.get(id).fetch(request);
}

function gameDORequest(
  request: Request,
  path: string,
  init?: RequestInit,
): Request {
  const url = new URL(request.url);
  url.pathname = path;
  url.search = "";
  return new Request(url.toString(), init ?? request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return jsonResponse({
        status: "ok",
        runtime: "cloudflare",
        durableObjects: true,
      });
    }

    const workerRoute = parseWorkerRoute(url.pathname);
    if (workerRoute) {
      if (workerRoute.path === "/lobbies") {
        if (!isWebSocketRequest(request)) {
          return jsonResponse(
            { error: "Expected WebSocket upgrade" },
            { status: 426 },
          );
        }
        const id = env.LOBBY.idFromName("public-lobbies");
        return env.LOBBY.get(id).fetch(request);
      }

      const gamePathMatch = workerRoute.path.match(
        /^\/game\/([A-Za-z0-9]{8})$/,
      );
      if (gamePathMatch) {
        if (isWebSocketRequest(request)) {
          return routeToGameDO(env, gamePathMatch[1], request);
        }
        return renderAppShell(request, env);
      }

      const createMatch = workerRoute.path.match(
        /^\/api\/create_game\/([A-Za-z0-9]{8})$/,
      );
      if (createMatch && request.method === "POST") {
        return routeToGameDO(env, createMatch[1], request);
      }

      const existsMatch = workerRoute.path.match(
        /^\/api\/game\/([A-Za-z0-9]{8})\/exists$/,
      );
      if (existsMatch && request.method === "GET") {
        return routeToGameDO(
          env,
          existsMatch[1],
          gameDORequest(request, `/api/game/${existsMatch[1]}/exists`),
        );
      }

      const gameInfoMatch = workerRoute.path.match(
        /^\/api\/game\/([A-Za-z0-9]{8})$/,
      );
      if (gameInfoMatch && request.method === "GET") {
        return routeToGameDO(
          env,
          gameInfoMatch[1],
          gameDORequest(request, `/api/game/${gameInfoMatch[1]}`),
        );
      }

      if (
        workerRoute.path === "/api/archive_singleplayer_game" &&
        request.method === "POST"
      ) {
        return jsonResponse({ ok: true, archived: false });
      }
    }

    if (isHtmlNavigation(request, url.pathname)) {
      return renderAppShell(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};

export class LobbyDurableObject {
  private lobbySockets = new Set<WebSocket>();
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.lobbySockets = new Set(this.state.getWebSockets());
    if (this.lobbySockets.size > 0) this.startBroadcasting();
  }

  async fetch(request: Request): Promise<Response> {
    if (!isWebSocketRequest(request)) {
      return jsonResponse(
        { error: "Expected WebSocket upgrade" },
        { status: 426 },
      );
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.state.acceptWebSocket(server);
    this.lobbySockets.add(server);

    await this.sendFull(server);
    this.startBroadcasting();

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): void {
    this.lobbySockets.delete(ws);
    this.stopBroadcastingIfIdle();
  }

  webSocketError(ws: WebSocket, _error: unknown): void {
    this.lobbySockets.delete(ws);
    this.stopBroadcastingIfIdle();
  }

  private startBroadcasting(): void {
    if (this.broadcastTimer !== null) return;
    const tick = async () => {
      this.broadcastTimer = null;
      if (this.lobbySockets.size === 0) return;
      await this.broadcastCounts();
      this.startBroadcasting();
    };
    this.broadcastTimer = setTimeout(tick, LOBBY_BROADCAST_INTERVAL_MS);
  }

  private stopBroadcastingIfIdle(): void {
    if (this.lobbySockets.size > 0 || this.broadcastTimer === null) return;
    clearTimeout(this.broadcastTimer);
    this.broadcastTimer = null;
  }

  private async sendFull(ws: WebSocket): Promise<void> {
    const snapshot = await this.publicGamesSnapshot();
    if (ws.readyState === WebSocket.OPEN) {
      safeSend(
        ws,
        JSON.stringify({
          type: "full",
          serverTime: snapshot.serverTime,
          games: snapshot.games,
        }),
      );
    }
  }

  private async broadcastCounts(): Promise<void> {
    const snapshot = await this.publicGamesSnapshot();
    const counts: Record<string, number> = {};
    for (const gameList of Object.values(snapshot.games)) {
      for (const game of gameList) {
        counts[game.gameID] = game.numClients;
      }
    }
    const payload = JSON.stringify({
      type: "counts",
      serverTime: snapshot.serverTime,
      counts,
    });
    for (const ws of this.lobbySockets) {
      if (ws.readyState === WebSocket.OPEN) {
        if (!safeSend(ws, payload)) {
          this.lobbySockets.delete(ws);
        }
      }
    }
  }

  private async publicGamesSnapshot(): Promise<PublicGames> {
    const games: Record<PublicGameType, PublicGameInfo[]> = {
      ffa: [],
      team: [],
      special: [],
    };

    for (const type of PUBLIC_GAME_TYPES) {
      games[type] = await this.availableGamesForType(type);
      if (games[type].length === 0) {
        games[type] = [await this.createPublicGame(type)];
      }
    }

    return {
      serverTime: Date.now(),
      games,
    };
  }

  private async availableGamesForType(
    type: PublicGameType,
  ): Promise<PublicGameInfo[]> {
    const knownIDs =
      (await this.state.storage.get<GameID[]>(`public:${type}`)) ?? [];
    const available: PublicGameInfo[] = [];
    const retainedIDs: GameID[] = [];

    for (const gameID of knownIDs) {
      const info = await this.fetchPublicGameInfo(gameID);
      if (!info || info.publicGameType !== type) continue;
      if (
        info.startsAt !== undefined &&
        info.startsAt > Date.now() &&
        info.numClients < (info.gameConfig?.maxPlayers ?? Infinity)
      ) {
        available.push(info);
        retainedIDs.push(gameID);
      }
    }

    await this.state.storage.put(`public:${type}`, retainedIDs.slice(-3));
    return available;
  }

  private async createPublicGame(
    type: PublicGameType,
  ): Promise<PublicGameInfo> {
    const gameID = generateID();
    const startsAt = Date.now() + PUBLIC_LOBBY_START_DELAY_MS;
    const id = this.env.GAME.idFromName(gameID);
    const stub = this.env.GAME.get(id);
    const initResponse = await stub.fetch(
      "https://game.openfront/internal/init",
      {
        method: "POST",
        body: JSON.stringify({
          id: gameID,
          gameConfig: publicGameConfig(type),
          startsAt,
          publicGameType: type,
        }),
      },
    );
    if (!initResponse.ok) {
      throw new Error(`Failed to create public game ${gameID}`);
    }
    const knownIDs =
      (await this.state.storage.get<GameID[]>(`public:${type}`)) ?? [];
    await this.state.storage.put(`public:${type}`, [...knownIDs, gameID]);
    const info = await initResponse.json();
    return info as PublicGameInfo;
  }

  private async fetchPublicGameInfo(
    gameID: GameID,
  ): Promise<PublicGameInfo | null> {
    const id = this.env.GAME.idFromName(gameID);
    const response = await this.env.GAME.get(id).fetch(
      "https://game.openfront/internal/public-info",
    );
    if (!response.ok) return null;
    return (await response.json()) as PublicGameInfo;
  }
}

export class GameDurableObject {
  private game: StoredGameState | null = null;
  private activeClients = new Map<ClientID, ConnectedClient>();
  private socketToClientID = new Map<WebSocket, ClientID>();
  private intents: StampedIntent[] = [];
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private lobbyInfoTimer: ReturnType<typeof setTimeout> | null = null;
  private emptySince: number | null = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.state.blockConcurrencyWhile(async () => {
      this.game =
        (await this.state.storage.get<StoredGameState>("game")) ?? null;
      this.rehydrateWebSockets();
      this.scheduleStartIfNeeded();
      if (this.game?.hasStarted && this.activeClients.size > 0) {
        this.startTurnLoop();
      }
      if (this.game && !this.game.hasStarted && this.activeClients.size > 0) {
        this.scheduleLobbyInfoBroadcast();
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/internal/init" && request.method === "POST") {
      const input = (await request.json()) as {
        id: GameID;
        gameConfig?: GameConfig;
        creatorPersistentID?: string;
        startsAt?: number;
        publicGameType?: PublicGameType;
      };
      return this.initializeGame(input);
    }

    if (url.pathname === "/internal/public-info") {
      if (!this.game || !this.isPublic()) return notFound();
      return jsonResponse(this.publicGameInfo());
    }

    const createMatch = url.pathname.match(
      /^\/w\d+\/api\/create_game\/([A-Za-z0-9]{8})$/,
    );
    if (createMatch && request.method === "POST") {
      return this.createPrivateGame(request, createMatch[1]);
    }

    const existsMatch = url.pathname.match(
      /^\/api\/game\/([A-Za-z0-9]{8})\/exists$/,
    );
    if (existsMatch) {
      return jsonResponse({ exists: this.game?.id === existsMatch[1] });
    }

    const infoMatch = url.pathname.match(/^\/api\/game\/([A-Za-z0-9]{8})$/);
    if (infoMatch) {
      if (!this.game || this.game.id !== infoMatch[1]) return notFound();
      return jsonResponse(this.gameInfo());
    }

    if (/^\/w\d+\/game\/[A-Za-z0-9]{8}$/.test(url.pathname)) {
      if (!isWebSocketRequest(request)) {
        return jsonResponse(
          { error: "Expected WebSocket upgrade" },
          { status: 426 },
        );
      }
      return this.acceptGameSocket();
    }

    return notFound();
  }

  private async initializeGame(input: {
    id: GameID;
    gameConfig?: GameConfig;
    creatorPersistentID?: string;
    startsAt?: number;
    publicGameType?: PublicGameType;
  }): Promise<Response> {
    if (!isValidGameID(input.id)) {
      return jsonResponse({ error: "Invalid game ID" }, { status: 400 });
    }
    if (this.game !== null) {
      return jsonResponse(
        this.isPublic() ? this.publicGameInfo() : this.gameInfo(),
      );
    }

    this.game = {
      id: input.id,
      createdAt: Date.now(),
      visibleAt: input.startsAt === undefined ? undefined : Date.now(),
      gameConfig: defaultGameConfig(input.gameConfig),
      creatorPersistentID: input.creatorPersistentID,
      startsAt: input.startsAt,
      publicGameType: input.publicGameType,
      hasPrestarted: false,
      hasStarted: false,
      hasEnded: false,
      turns: [],
      persistentIdToClientId: {},
      allClients: {},
    };
    await this.persistGame();
    this.scheduleStartIfNeeded();
    return jsonResponse(
      this.isPublic() ? this.publicGameInfo() : this.gameInfo(),
    );
  }

  private async createPrivateGame(
    request: Request,
    id: GameID,
  ): Promise<Response> {
    if (this.game !== null) {
      return jsonResponse({ error: "Game ID already exists" }, { status: 409 });
    }
    const body = await request.json().catch(() => ({}));
    const parsed = CreateGameInputSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ error: parsed.error.message }, { status: 400 });
    }
    const authorization = request.headers.get("Authorization") ?? "";
    const token = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;
    const creatorPersistentID = token ? extractPersistentID(token) : undefined;

    return this.initializeGame({
      id,
      gameConfig: defaultGameConfig(parsed.data),
      creatorPersistentID,
    });
  }

  private acceptGameSocket(): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.state.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    ws: WebSocket,
    data: string | ArrayBuffer,
  ): Promise<void> {
    try {
      await this.handleSocketMessage(ws, data);
    } catch (error: unknown) {
      this.sendError(ws, "server-error", String(error));
    }
  }

  webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): void {
    this.disconnectSocket(ws);
  }

  webSocketError(ws: WebSocket, _error: unknown): void {
    this.disconnectSocket(ws);
  }

  private socketAttachment(ws: WebSocket): SocketAttachment | null {
    const attachment = ws.deserializeAttachment();
    if (attachment && typeof attachment === "object") {
      return attachment as SocketAttachment;
    }
    return null;
  }

  private rehydrateWebSockets(): void {
    if (!this.game) return;
    for (const ws of this.state.getWebSockets()) {
      const clientID = this.socketAttachment(ws)?.clientID;
      if (clientID && this.game.allClients[clientID]) {
        this.attachSocketToClient(ws, clientID);
      }
    }
  }

  private async handleSocketMessage(
    ws: WebSocket,
    data: string | ArrayBuffer,
  ): Promise<void> {
    const raw =
      typeof data === "string" ? data : new TextDecoder().decode(data);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.sendError(ws, "invalid-message", "Invalid JSON");
      ws.close(1002, "invalid-message");
      return;
    }

    const parsed = ClientMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.sendError(ws, "invalid-message", parsed.error.message);
      ws.close(1002, "invalid-message");
      return;
    }

    const message = parsed.data;
    if (!this.socketToClientID.has(ws)) {
      await this.handleInitialMessage(ws, message);
      return;
    }

    await this.handleClientMessage(ws, message);
  }

  private async handleInitialMessage(
    ws: WebSocket,
    message: ClientMessage,
  ): Promise<void> {
    if (message.type === "join") {
      await this.join(ws, message);
      return;
    }
    if (message.type === "rejoin") {
      await this.rejoin(ws, message);
      return;
    }
    this.sendError(ws, "join-required", "First message must join or rejoin");
  }

  private async join(ws: WebSocket, message: ClientJoinMessage): Promise<void> {
    if (!this.game || this.game.id !== message.gameID) {
      this.sendError(ws, "not_found", "Game not found");
      ws.close(1000, "not_found");
      return;
    }

    const persistentID = extractPersistentID(message.token);
    const existingClientID = this.game.persistentIdToClientId[persistentID];
    if (existingClientID) {
      this.attachSocketToClient(ws, existingClientID);
      if (this.game.hasStarted) this.sendStartGameMsg(ws, 0);
      else this.broadcastLobbyInfo();
      return;
    }

    const maxPlayers = this.game.gameConfig.maxPlayers ?? Infinity;
    if (this.activeClients.size >= maxPlayers) {
      this.sendError(ws, "full-lobby");
      return;
    }

    const clientID = generateID();
    const storedClient: StoredClient = {
      clientID,
      persistentID,
      username: message.username,
      clanTag: message.clanTag ?? null,
      cosmetics: message.cosmetics,
    };
    this.game.persistentIdToClientId[persistentID] = clientID;
    this.game.allClients[clientID] = storedClient;
    if (
      this.game.creatorPersistentID !== undefined &&
      this.game.creatorPersistentID === persistentID
    ) {
      this.game.lobbyCreatorID = clientID;
    }
    this.attachSocketToClient(ws, clientID);
    await this.persistGame();
    this.broadcastLobbyInfo();
    this.scheduleLobbyInfoBroadcast();
    this.scheduleStartIfNeeded();

    if (this.game.hasStarted) {
      this.sendStartGameMsg(ws, 0);
    }
  }

  private async rejoin(
    ws: WebSocket,
    message: ClientRejoinMessage,
  ): Promise<void> {
    if (!this.game || this.game.id !== message.gameID) {
      this.sendError(ws, "not_found", "Game not found");
      return;
    }
    const persistentID = extractPersistentID(message.token);
    const clientID = this.game.persistentIdToClientId[persistentID];
    if (!clientID) {
      this.sendError(ws, "not_found", "Client not found");
      return;
    }
    this.attachSocketToClient(ws, clientID);
    if (this.game.hasStarted) {
      this.sendStartGameMsg(ws, message.lastTurn);
    } else {
      this.broadcastLobbyInfo();
    }
  }

  private async handleClientMessage(
    ws: WebSocket,
    message: ClientMessage,
  ): Promise<void> {
    const clientID = this.socketToClientID.get(ws);
    if (!clientID) return;
    const client = this.activeClients.get(clientID);
    if (!client) return;

    switch (message.type) {
      case "ping":
        client.lastPing = Date.now();
        return;
      case "rejoin":
        if (this.game?.hasStarted) this.sendStartGameMsg(ws, message.lastTurn);
        return;
      case "intent":
        if (!this.game?.hasStarted) {
          if (message.intent.type === "toggle_game_start_timer") {
            this.toggleStartTimer(clientID);
          } else if (message.intent.type === "update_game_config") {
            await this.updateGameConfig(clientID, message.intent.config);
          }
          return;
        }
        this.intents.push({ ...message.intent, clientID });
        return;
      case "hash":
      case "winner":
      case "log":
      case "join":
        return;
    }
  }

  private attachSocketToClient(ws: WebSocket, clientID: ClientID): void {
    if (!this.game) return;
    const stored = this.game.allClients[clientID];
    if (!stored) return;

    const previous = this.activeClients.get(clientID);
    if (previous && previous.ws !== ws) {
      try {
        previous.ws.close(1000, "duplicate-session");
      } catch {
        // Ignore stale socket close failures.
      }
      this.socketToClientID.delete(previous.ws);
    }

    ws.serializeAttachment({ clientID } satisfies SocketAttachment);
    this.socketToClientID.set(ws, clientID);
    this.activeClients.set(clientID, {
      ...stored,
      ws,
      lastPing: Date.now(),
    });
  }

  private disconnectSocket(ws: WebSocket): void {
    const clientID = this.socketToClientID.get(ws);
    if (!clientID) return;
    this.socketToClientID.delete(ws);
    this.activeClients.delete(clientID);

    if (!this.game?.hasStarted) {
      const client = this.game?.allClients[clientID];
      if (client && this.game) {
        delete this.game.persistentIdToClientId[client.persistentID];
        delete this.game.allClients[clientID];
        this.persistGame().catch(() => undefined);
      }
      this.broadcastLobbyInfo();
    }
  }

  private async updateGameConfig(
    clientID: ClientID,
    config: Partial<GameConfig>,
  ): Promise<void> {
    if (!this.game || this.isPublic()) return;
    if (this.game.lobbyCreatorID !== clientID) return;
    if (config.gameType === GameType.Public) return;
    this.game.gameConfig = defaultGameConfig({
      ...this.game.gameConfig,
      ...config,
      gameType: GameType.Private,
    });
    await this.persistGame();
    this.broadcastLobbyInfo();
  }

  private toggleStartTimer(clientID: ClientID): void {
    if (!this.game || this.isPublic()) return;
    if (this.game.lobbyCreatorID !== clientID) return;
    if (this.game.hasStarted) return;
    if (this.game.startsAt !== undefined) {
      this.game.startsAt = undefined;
    } else {
      this.game.startsAt =
        Date.now() + (this.game.gameConfig.startDelay ?? 0) * 1000;
      this.game.visibleAt ??= Date.now();
    }
    this.persistGame().catch(() => undefined);
    this.broadcastLobbyInfo();
    this.scheduleStartIfNeeded();
  }

  private scheduleStartIfNeeded(): void {
    if (this.startTimer !== null) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    if (
      !this.game ||
      this.game.hasEnded ||
      this.game.hasStarted ||
      this.game.startsAt === undefined
    ) {
      return;
    }
    const delay = Math.max(0, this.game.startsAt - Date.now());
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      this.prestartAndStart().catch(() => undefined);
    }, delay);
  }

  private async prestartAndStart(): Promise<void> {
    if (!this.game || this.game.hasStarted || this.game.hasEnded) return;
    if (this.activeClients.size === 0) {
      this.game.hasEnded = this.isPublic();
      await this.persistGame();
      return;
    }
    if (!this.game.hasPrestarted) {
      this.game.hasPrestarted = true;
      const message: ServerPrestartMessage = {
        type: "prestart",
        gameMap: this.game.gameConfig.gameMap,
        gameMapSize: this.game.gameConfig.gameMapSize,
      };
      this.broadcast(message);
      await this.persistGame();
    }
    setTimeout(
      () => this.startGame().catch(() => undefined),
      PRESTART_TO_START_DELAY_MS,
    );
  }

  private async startGame(): Promise<void> {
    if (!this.game || this.game.hasStarted || this.game.hasEnded) return;
    this.game.hasStarted = true;
    this.game.startTime = Date.now();
    const players = Array.from(this.activeClients.values()).map(
      (client): Player => ({
        clientID: client.clientID,
        username: client.username,
        clanTag: this.game?.gameConfig.disableClanTags ? null : client.clanTag,
        cosmetics: client.cosmetics
          ? {
              flag: client.cosmetics.flag,
              color: client.cosmetics.color
                ? { color: client.cosmetics.color }
                : undefined,
            }
          : undefined,
        isLobbyCreator: this.game?.lobbyCreatorID === client.clientID,
      }),
    );
    const parsed = GameStartInfoSchema.safeParse({
      gameID: this.game.id,
      lobbyCreatedAt: this.game.createdAt,
      visibleAt: this.game.visibleAt,
      config: this.game.gameConfig,
      players,
    });
    if (!parsed.success) {
      this.broadcastError("invalid-start-info", parsed.error.message);
      return;
    }
    this.game.gameStartInfo = parsed.data;
    await this.persistGame();
    for (const client of this.activeClients.values()) {
      this.sendStartGameMsg(client.ws, 0);
    }
    this.startTurnLoop();
  }

  private startTurnLoop(): void {
    if (this.turnTimer !== null) return;
    const tick = async () => {
      this.turnTimer = null;
      if (!this.game?.hasStarted || this.game.hasEnded) return;
      if (
        this.game.startTime !== undefined &&
        Date.now() > this.game.startTime + MAX_GAME_DURATION_MS
      ) {
        this.game.hasEnded = true;
        await this.persistGame();
        return;
      }
      if (this.activeClients.size === 0) {
        this.emptySince ??= Date.now();
        if (Date.now() - this.emptySince >= EMPTY_GAME_IDLE_TIMEOUT_MS) {
          this.game.hasEnded = true;
          await this.persistGame();
          return;
        }
      } else {
        this.emptySince = null;
      }
      await this.endTurn();
      this.startTurnLoop();
    };
    this.turnTimer = setTimeout(tick, TURN_INTERVAL_MS);
  }

  private async endTurn(): Promise<void> {
    if (!this.game) return;
    const turn: Turn = {
      turnNumber: this.game.turns.length,
      intents: this.intents,
    };
    this.game.turns.push(turn);
    this.intents = [];
    this.broadcast({
      type: "turn",
      turn,
    } satisfies ServerTurnMessage);
  }

  private sendStartGameMsg(ws: WebSocket, lastTurn: number): void {
    if (!this.game?.gameStartInfo) return;
    const clientID = this.socketToClientID.get(ws);
    if (!clientID) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    safeSend(
      ws,
      JSON.stringify({
        type: "start",
        turns: this.game.turns.slice(lastTurn),
        gameStartInfo: this.game.gameStartInfo,
        lobbyCreatedAt: this.game.createdAt,
        myClientID: clientID,
      } satisfies ServerStartGameMessage),
    );
  }

  private scheduleLobbyInfoBroadcast(): void {
    if (this.lobbyInfoTimer !== null) return;
    const tick = () => {
      this.lobbyInfoTimer = null;
      if (!this.game || this.game.hasStarted || this.activeClients.size === 0) {
        return;
      }
      this.broadcastLobbyInfo();
      this.scheduleLobbyInfoBroadcast();
    };
    this.lobbyInfoTimer = setTimeout(tick, LOBBY_BROADCAST_INTERVAL_MS);
  }

  private broadcastLobbyInfo(): void {
    if (!this.game || this.game.hasStarted) return;
    for (const client of this.activeClients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        safeSend(
          client.ws,
          JSON.stringify({
            type: "lobby_info",
            lobby: this.gameInfo(),
            myClientID: client.clientID,
          } satisfies ServerLobbyInfoMessage),
        );
      }
    }
  }

  private broadcast(message: ServerPrestartMessage | ServerTurnMessage): void {
    const payload = JSON.stringify(message);
    for (const client of this.activeClients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        safeSend(client.ws, payload);
      }
    }
  }

  private sendError(ws: WebSocket, error: string, message?: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    safeSend(
      ws,
      JSON.stringify({
        type: "error",
        error,
        message,
      } satisfies ServerErrorMessage),
    );
  }

  private broadcastError(error: string, message?: string): void {
    for (const client of this.activeClients.values()) {
      this.sendError(client.ws, error, message);
    }
  }

  private gameInfo(): GameInfo {
    if (!this.game) throw new Error("Game not initialized");
    const info = {
      gameID: this.game.id,
      clients: Array.from(this.activeClients.values()).map((client) => ({
        clientID: client.clientID,
        username: client.username,
        clanTag: client.clanTag,
      })),
      lobbyCreatorClientID: this.game.lobbyCreatorID,
      startsAt: this.game.startsAt,
      serverTime: Date.now(),
      gameConfig: this.game.gameConfig,
      publicGameType: this.game.publicGameType,
    };
    return GameInfoSchema.parse(info);
  }

  private publicGameInfo(): PublicGameInfo {
    if (!this.game || !this.game.publicGameType) {
      throw new Error("Public game not initialized");
    }
    return {
      gameID: this.game.id,
      numClients: this.activeClients.size,
      startsAt: this.game.startsAt,
      gameConfig: this.game.gameConfig,
      publicGameType: this.game.publicGameType,
    };
  }

  private isPublic(): boolean {
    return this.game?.gameConfig.gameType === GameType.Public;
  }

  private async persistGame(): Promise<void> {
    if (this.game) await this.state.storage.put("game", this.game);
  }
}
