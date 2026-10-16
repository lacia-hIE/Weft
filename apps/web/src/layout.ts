import { useEffect, useState } from "react";
import {
  computeColumns,
  SIDEBAR_DEFAULT,
  SIDEBAR_AUTO_COLLAPSE,
  SIDEBAR_COLLAPSED,
  RIGHTBAR_DEFAULT_RATIO,
  clampWidth,
  SIDEBAR_MIN,
  SIDEBAR_MAX,
} from "./upstream-ui.ts";

export function useLayout(enabledPlugins: number) {
  const [width, setWidth] = useState(window.innerWidth);
  const [sidebar, setSidebar] = useState(SIDEBAR_DEFAULT);
  const [narrowExpanded, setNarrowExpanded] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [rightWidth, setRightWidth] = useState<number | undefined>();
  useEffect(() => {
    const resize = () => {
      setWidth(window.innerWidth);
    };
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
    };
  }, []);
  useEffect(() => {
    if (enabledPlugins) {
      setRightOpen(true);
      setNarrowExpanded(false);
    } else setRightOpen(false);
  }, [enabledPlugins]);
  const collapsed =
    width < SIDEBAR_AUTO_COLLAPSE ? !narrowExpanded : sidebar === 0;
  const columns = computeColumns(
    width,
    collapsed ? 0 : sidebar || SIDEBAR_DEFAULT,
    rightOpen ? (rightWidth ?? width * RIGHTBAR_DEFAULT_RATIO) : 0,
  );
  const overlay = rightOpen && columns.rightbar === 0;
  return {
    columns,
    collapsed,
    rightOpen,
    overlay,
    toggleSidebar: () => {
      if (width < SIDEBAR_AUTO_COLLAPSE) setNarrowExpanded((value) => !value);
      else setSidebar((value) => (value ? 0 : SIDEBAR_DEFAULT));
    },
    toggleRight: () => {
      setRightOpen((value) => !value);
      setNarrowExpanded(false);
    },
    resizeSidebar: (value: number) => {
      setSidebar(clampWidth(value, SIDEBAR_MIN, SIDEBAR_MAX));
    },
    resizeRight: (value: number) => {
      setRightWidth(Math.max(300, value));
    },
    style: {
      gridTemplateColumns: `${columns.sidebar}px minmax(0,1fr) ${columns.rightbar}px`,
      "--weft-rail": `${SIDEBAR_COLLAPSED}px`,
    },
  };
}
