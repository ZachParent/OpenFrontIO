import { assetUrl } from "../core/AssetUrls";

const CRITICAL_GAMEPLAY_HUD_ASSETS = [
  "images/AllianceIconWhite.svg",
  "images/BoatIconWhite.svg",
  "images/BuildIconWhite.svg",
  "images/ChatIconWhite.svg",
  "images/DonateGoldIconWhite.svg",
  "images/DonateTroopIconWhite.svg",
  "images/EmojiIconWhite.svg",
  "images/InfoIcon.svg",
  "images/SwordIconWhite.svg",
  "images/TargetIconWhite.svg",
  "images/TraitorIconWhite.svg",
  "images/XIcon.svg",
  "images/CityIconWhite.svg",
  "images/FactoryIconWhite.svg",
  "images/MIRVIcon.svg",
  "images/MissileSiloIconWhite.svg",
  "images/MushroomCloudIconWhite.svg",
  "images/NukeIconWhite.svg",
  "images/PortIcon.svg",
  "images/SamLauncherIconWhite.svg",
  "images/ShieldIconWhite.svg",
];

export function preloadGameplayHudAssets(): void {
  const urls = new Set(
    CRITICAL_GAMEPLAY_HUD_ASSETS.map((path) => assetUrl(path)),
  );

  for (const url of urls) {
    const link = document.createElement("link");
    link.rel = "preload";
    link.as = "image";
    link.href = url;
    document.head.appendChild(link);

    const image = new Image();
    image.decoding = "async";
    image.src = url;
  }
}
