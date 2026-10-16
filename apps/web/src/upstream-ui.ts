// Pinned upstream presentation seam. Keep internal stylesheet imports here so
// an upstream update has one small, explicit surface to review.
export { default as sidebarCss } from "@weft/upstream/packages/client/ui-sidebar/src/client/SidebarRoot.module.css";
export { default as composerCss } from "@weft/upstream/packages/client/ui-conversation/src/client/skeleton/InputBar.module.css";
export { default as heroCss } from "@weft/upstream/packages/client/ui-conversation/src/client/skeleton/HeroShell.module.css";
export { default as messageCss } from "@weft/upstream/packages/client/ui-chat/src/client/chat/MessageItem.module.css";
export { default as pluginsCss } from "@weft/upstream/packages/client/ui-plugin-manager/src/client/PluginManagerPage.module.css";
export { DisclosureRow } from "@weft/upstream/packages/client/ui-primitives/src/DisclosureRow.tsx";
export {
  IconPanelLeftOutlineRegular,
  IconPluginPinwheelOutlineRegular,
  IconFolderOpenRegular,
  IconNewChatOutlineRegular,
  IconSettingsOutlineRegular,
} from "@weft/upstream/packages/client/ui-primitives/src/icons/index.tsx";
export {
  computeColumns,
  SIDEBAR_DEFAULT,
  SIDEBAR_AUTO_COLLAPSE,
  SIDEBAR_COLLAPSED,
  RIGHTBAR_DEFAULT_RATIO,
  clampWidth,
  SIDEBAR_MIN,
  SIDEBAR_MAX,
} from "@weft/upstream/packages/client/ui-layout/src/client/columns.ts";
