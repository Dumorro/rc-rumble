/**
 * RC RUMBLE — UI public surface.
 *
 *   import { UISystem } from './ui/index.js';
 *
 * Everything below is safe to use from other systems; anything not exported
 * here is an implementation detail of the UI layer.
 */

export { UISystem, UISystem as default } from './UISystem.js';
export { Settings, DEFAULTS as SETTINGS_DEFAULTS, QUALITY_LEVELS, CAMERA_MODES, CAMERA_LABELS } from './Settings.js';
export { Screen, MenuList } from './Screen.js';

export {
  THEME, injectStyles, withAlpha, hexOf, mixHex,
  drawDisplay, measureDisplay, measureDisplayEm,
  displayTextCanvas, setDisplayText, refreshDisplayText, fitCanvas, dpr,
} from './Theme.js';

export {
  el, clear, setText, setClass, setStyle, on, formatTime, formatDelta,
  formatGap, ordinal, ordinalParts, formatLength, isTouchDevice,
} from './Dom.js';

export { HUD } from './hud/HUD.js';
export { Telemetry } from './hud/Telemetry.js';
export { Speedometer } from './hud/Speedo.js';
export { Minimap } from './hud/Minimap.js';
export { PickupSlot } from './hud/PickupSlot.js';
export {
  drawWeaponIcon, blitWeaponIcon, iconCanvas, iconIdFor,
  colorFor as weaponColor, labelFor as weaponLabel, WEAPON_COLOR, WEAPON_LABEL, REEL_ORDER,
} from './hud/WeaponIcons.js';

export { TouchControls } from './TouchControls.js';
export { CarPreview } from './CarPreview.js';
export {
  extractOutline, outlineFor, cacheOutline, syntheticOutline,
  fitOutline, drawRibbon, outlineLength,
} from './TrackMap.js';

export { MainMenu } from './screens/MainMenu.js';
export { CarSelect, LIVERY_PALETTE } from './screens/CarSelect.js';
export { TrackSelect, drawTrackThumb } from './screens/TrackSelect.js';
export { Loading } from './screens/Loading.js';
export { Pause } from './screens/Pause.js';
export { Results, POINTS } from './screens/Results.js';
export { Options } from './screens/Options.js';
export { Controls } from './screens/Controls.js';
