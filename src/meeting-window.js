"use strict";

/** Janela do modo de reuniÃ£o: a pÃ­lula do cluely, fora da barra e da captura. */
function meetingBrowserOptions() {
  return {
    width: 600,
    height: 48,
    minWidth: 480,
    minHeight: 48,
    frame: false,
    transparent: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    hasShadow: false,
    show: false,
    backgroundColor: "#00000000",
    title: "HELIOS — Reunião",
  };
}

function applyMeetingProtection(win, env = process.env) {
  const contentProtection = env.HELIOS_NO_PROTECT !== "1";
  win.setContentProtection(contentProtection);
  win.setSkipTaskbar(true);
  if (typeof win.setAlwaysOnTop === "function") win.setAlwaysOnTop(true, "screen-saver");
  if (typeof win.setVisibleOnAllWorkspaces === "function") win.setVisibleOnAllWorkspaces(true);
  return { contentProtection, skipTaskbar: true };
}

/**
 * Fecha o modo de reuniÃ£o: desliga o modo atravessar (senÃ£o a janela volta sem aceitar clique), avisa a pÃ¡gina para
 * parar a captura de Ã¡udio (stop) e esconde a janela. Os atalhos globais continuam no app para reabrir com Ctrl+Shift+EspaÃ§o.
 */
function closeMeetingWindow(win, { stop = true } = {}) {
  if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) return false;
  if (win._heliosClickThrough) {
    win._heliosClickThrough = false;
    if (typeof win.setIgnoreMouseEvents === "function") win.setIgnoreMouseEvents(false);
  }
  const contents = win.webContents;
  if (contents && !(typeof contents.isDestroyed === "function" && contents.isDestroyed())) {
    contents.send("meeting:stop", { stop: Boolean(stop), clickThrough: false });
  }
  win.hide();
  return true;
}

/**
 * Barra de tÃ­tulo integrada da janela principal (Windows/Linux): a barra nativa some e os botÃµes de minimizar, maximizar
 * e fechar ficam num overlay com as cores do tema. As cores espelham --titlebar-bg / --titlebar-fg de renderer/tokens.css
 * (escuro: #0a0a0a com sÃ­mbolos claros; claro: #fafafa com sÃ­mbolos escuros). A altura (44px) Ã© a mesma da faixa do topo
 * da sidebar (--bar-h), entÃ£o o conteÃºdo nunca fica embaixo dos botÃµes.
 */
const TITLEBAR_HEIGHT = 48;
const TITLEBAR_COLORS = {
  dark: { color: "#0B0B0D", symbolColor: "#F4EEE2" },
  light: { color: "#F7F3EA", symbolColor: "#2A1D08" },
};

/** SÃ³ "light" e "dark" valem; qualquer outro valor (vindo do renderer) cai no escuro. */
function normalizeTheme(theme) {
  return theme === "light" ? "light" : "dark";
}

function titleBarOverlayFor(theme) {
  return { ...TITLEBAR_COLORS[normalizeTheme(theme)], height: TITLEBAR_HEIGHT };
}

/** Janela principal, normal e visÃ­vel. */
function mainBrowserOptions(theme = "dark") {
  return {
    width: 1180,
    height: 800,
    minWidth: 860,
    minHeight: 560,
    frame: true,
    titleBarStyle: "hidden",
    titleBarOverlay: titleBarOverlayFor(theme),
    skipTaskbar: false,
    show: false,
    title: "HELIOS",
    backgroundColor: TITLEBAR_COLORS[normalizeTheme(theme)].color,
    autoHideMenuBar: true,
  };
}

/** Troca as cores da barra de tÃ­tulo (e o fundo da janela) quando o tema muda. NÃ£o faz nada se a janela nÃ£o existe mais. */
function applyMainWindowTheme(win, theme) {
  if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) return false;
  const overlay = titleBarOverlayFor(theme);
  try {
    if (typeof win.setTitleBarOverlay === "function") win.setTitleBarOverlay(overlay);
    if (typeof win.setBackgroundColor === "function") win.setBackgroundColor(overlay.color);
  } catch {
    return false;
  }
  return true;
}

module.exports = {
  meetingBrowserOptions, applyMeetingProtection, closeMeetingWindow, mainBrowserOptions,
  titleBarOverlayFor, normalizeTheme, applyMainWindowTheme, TITLEBAR_HEIGHT,
};
