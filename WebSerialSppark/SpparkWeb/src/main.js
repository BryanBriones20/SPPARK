import "./style.css";
import { BrowserMultiFormatReader } from "@zxing/browser";

/* =========================
   Config / Const
========================= */
const SERVO_COUNT = 7;
const JOINT_LABELS = [
  "CH0", "CH1", "CH2", "CH3", "CH4", "CH5", "CH6 (Gripper)"
];

const LS_KEY = "aurora6_dashboard_v1";

/* =========================
   State
========================= */
let angles = new Array(SERVO_COUNT).fill(90);

// Manual -> Replica
let ida = [];
let regreso = [];

// Auto -> Programación
let program = [];

// Movement control
let playing = false;
let stopRequested = false;

// Serial
let port = null;
let reader = null;
let writer = null;
let readLoopRunning = false;

// Throttle
let sendTimer = null;

// Slider refs (evitar rebuild constante)
let sliderRangeEls = [];
let sliderNumEls = [];

// QR / Camera
const qr = {
  reader: new BrowserMultiFormatReader(),
  controls: null,
  streamOn: false,
  lastRaw: "",
  lastPayload: null, // { id, angles }
};

// Settings
let settings = {
  throttleMs: 250,
  sendOnRelease: true,
  interpSteps: 1,   // recomendado 1 si firmware suaviza
  pauseMs: 250,
};

// Auto state/config
let autoState = {
  armed: false,
  busy: false,
  waitingForQR: false,

  // posiciones
  home: new Array(SERVO_COUNT).fill(90),
  pick: new Array(SERVO_COUNT).fill(90),

  // gripper
  gripOpen: 20,
  gripClose: 90,

  // tiempos
  dwellPickMs: 250,
  dwellAfterOpenMs: 250,

  // comandos banda (tu firmware los implementará después)
  bandStopCmd: "band stop",
  bandRunCmd: "band run",

  statusText: "Idle",
};

/* =========================
   DOM
========================= */
const app = document.querySelector("#app");
if (!app) {
  document.body.innerHTML = `<pre style="padding:16px">Falta <div id="app"></div> en index.html</pre>`;
  throw new Error("Missing #app");
}

app.innerHTML = `
  <div class="container">
    <header class="hero">
      <div class="heroLeft">
        <div class="brandRow">
          <div class="brandMark"></div>
          <div>
            <div class="brandName">SPPARK3</div>
            <div class="brandSub">6GDL Manipulator • ESP32 + PCA9685 • WebSerial + QR</div>
          </div>
        </div>

        <div class="heroStats">
          <div class="stat">
            <div class="statK">Estado</div>
            <div class="statV"><span id="serialStatus" class="pill">Desconectado</span></div>
          </div>
          <div class="stat">
            <div class="statK">Modo</div>
            <div class="statV">Manual / Auto</div>
          </div>
          <div class="stat">
            <div class="statK">Canales</div>
            <div class="statV">7 (CH0..CH6)</div>
          </div>
          <div class="stat">
            <div class="statK">Gripper</div>
            <div class="statV">CH6</div>
          </div>
        </div>

        <div class="heroHint">
          Consejo: para cámara USB y WebSerial usa Chrome/Edge en <span class="mono">http://localhost:5173</span>.
        </div>
      </div>

      <div class="heroRight">
        <div class="heroArtCard">
          <img class="heroArt" src="/robot_render.jpeg" alt="Robot render" />
          <div class="heroArtLabel">Render • Proyecto Brazo 6GDL</div>
        </div>
      </div>
    </header>

    <div class="layout">
      <aside class="sidebar">

        <div class="sideCard">
          <div class="sideTitle">Estado del Sistema</div>

          <div class="ledRow">
            <div class="ledItem"><span id="ledSerial" class="led"></span><span>Serial</span></div>
            <div class="ledItem"><span id="ledCam" class="led"></span><span>Cámara</span></div>
            <div class="ledItem"><span id="ledAuto" class="led"></span><span>Auto</span></div>
          </div>

          <div class="miniKv"><span>Último cmd</span><span id="statLastCmd" class="mono">-</span></div>
          <div class="miniKv"><span>Último envío</span><span id="statLastSent" class="mono">-</span></div>
        </div>

        <div class="sideCard">
          <div class="sideTitle">Acciones rápidas</div>
          <div class="sideBtns">
            <button id="qConnect">Conectar</button>
            <button id="qDisconnect" class="ghost" disabled>Desconectar</button>

            <div class="sep"></div>

            <button id="qHome" class="ghost" disabled>Ir HOME</button>
            <button id="qPick" class="ghost" disabled>Ir PICK</button>

            <div class="sep"></div>

            <button id="qArm" class="ghost" disabled>Armar Auto</button>
            <button id="qStop" class="danger" disabled>STOP</button>
          </div>

          <div class="hint" style="margin-top:10px">
            Atajos: <span class="mono">Ctrl+Enter</span> enviar • <span class="mono">Esc</span> stop
          </div>
        </div>

        <div class="sideCard">
          <div class="sideTitle">Puntos</div>
          <div class="chips">
            <span class="chip">Ida <b id="statIda">0</b></span>
            <span class="chip">Regreso <b id="statReg">0</b></span>
            <span class="chip">Prog <b id="statProg">0</b></span>
          </div>
          <div class="hint" style="margin-top:10px">
            Recomendación: si tu firmware ya suaviza, usa <span class="mono">Interp steps = 1</span>.
          </div>
        </div>

      </aside>

      <main class="main">

        <!-- Serial + Console -->
        <section class="card">
          <div class="row">
            <button id="btnConnect">Connect Serial</button>
            <button id="btnDisconnect" disabled>Disconnect</button>
          </div>

          <div class="row">
            <input id="txtCmd" class="input" placeholder='Comando crudo (ej: help | show | speed 1 15 | 90 90 90 90 90 90 90)' />
            <button id="btnSend" disabled>Send</button>
          </div>

          <div class="row">
            <textarea id="console" class="console" readonly></textarea>
          </div>

          <p class="hint">
            Si no deja conectar: cierra Serial Monitor del IDE. WebSerial funciona en Chrome/Edge.
          </p>
        </section>

        <!-- Tabs -->
        <section class="card">
          <div class="tabs">
            <button class="tab active" data-tab="manual">Manual</button>
            <button class="tab" data-tab="auto">Automático</button>
          </div>

          <!-- MANUAL -->
          <div id="tab-manual" class="tabPanel">

            <h2>Modo Manual</h2>

            <div class="row">
              <span class="pill mono">Comando: <span id="cmdPreview"></span></span>
              <button id="btnSendNow" disabled>Send now</button>
              <button id="btnCenter" disabled>Center (90)</button>
              <button id="btnZero" disabled>Zero (0)</button>
            </div>

            <div class="row">
              <label class="hint">Throttle (ms)</label>
              <input id="throttleMs" type="number" class="num" min="20" max="2000" value="250" />

              <label class="hint">Enviar al soltar</label>
              <input id="sendOnRelease" type="checkbox" checked />

              <label class="hint">Interp steps</label>
              <input id="interpSteps" type="number" class="num" min="1" max="200" value="1" />

              <label class="hint">Pausa (ms)</label>
              <input id="pauseMs" type="number" class="num" min="0" max="20000" value="250" />

              <span class="hint warn">Si firmware ya suaviza, deja Interp=1</span>
            </div>

            <div id="sliders" class="sliders"></div>

            <hr />

            <h2>Modo Réplica (Ida / Regreso)</h2>

            <div class="row">
              <input id="pointName" class="input" placeholder="Nombre del punto (opcional)" />
              <button id="btnSaveIda" disabled>Guardar en Ida</button>
              <button id="btnSaveReg" disabled>Guardar en Regreso</button>
              <button id="btnExport" disabled>Export JSON</button>
              <button id="btnImport">Import JSON</button>
              <input id="importFile" type="file" accept="application/json" style="display:none" />
            </div>

            <div class="row">
              <button id="btnPlayIda" disabled>Play Ida</button>
              <button id="btnPlayReg" disabled>Play Regreso</button>
              <button id="btnPlayBoth" disabled>Play Ida + Regreso</button>
              <button id="btnStop" disabled>Stop</button>
              <span id="playState" class="pill">Idle</span>
            </div>

            <div class="grid2">
              <div class="box">
                <div class="row spaceBetween">
                  <b>Ida</b>
                  <span class="pill" id="countIda">0</span>
                  <button id="btnClearIda" class="danger" disabled>Clear Ida</button>
                </div>
                <div id="listIda" class="list"></div>
              </div>

              <div class="box">
                <div class="row spaceBetween">
                  <b>Regreso</b>
                  <span class="pill" id="countReg">0</span>
                  <button id="btnClearReg" class="danger" disabled>Clear Regreso</button>
                </div>
                <div id="listReg" class="list"></div>
              </div>
            </div>

            <p class="hint">
              “Cargar” copia a sliders. “Ir” envía la postura. “Play” recorre la lista.
            </p>
          </div>

          <!-- AUTO -->
          <div id="tab-auto" class="tabPanel hidden">
            <h2>Modo Automático</h2>

            <div class="row">
              <span id="autoStatus" class="pill">Idle</span>
              <button id="btnArmAuto" disabled>Armar Auto</button>
              <button id="btnDisarmAuto" disabled class="ghost">Desarmar</button>
              <button id="btnStopAuto" disabled class="danger">STOP Auto</button>
            </div>

            <div class="grid2">
              <div class="box">
                <b>Config del Robot (Auto)</b>

                <div class="row" style="margin-top:10px">
                  <button id="btnGoHome" disabled class="ghost">Ir a HOME</button>
                  <button id="btnGoPick" disabled class="ghost">Ir a PICK</button>
                  <button id="btnSetHomeFromCurrent" disabled>Home = actual</button>
                  <button id="btnSetPickFromCurrent" disabled>Pick = actual</button>
                </div>

                <div class="profileGrid">
                  <div class="profileRow">
                    <span class="k">Gripper Open</span>
                    <input id="gripOpen" class="num" type="number" min="0" max="180" />
                    <span class="hint">ángulo CH6</span>
                  </div>

                  <div class="profileRow">
                    <span class="k">Gripper Close</span>
                    <input id="gripClose" class="num" type="number" min="0" max="180" />
                    <span class="hint">ángulo CH6</span>
                  </div>

                  <div class="profileRow">
                    <span class="k">Hold pick (ms)</span>
                    <input id="dwellPickMs" class="num" type="number" min="0" max="10000" />
                    <span class="hint">espera tras cerrar</span>
                  </div>

                  <div class="profileRow">
                    <span class="k">Hold open (ms)</span>
                    <input id="dwellAfterOpenMs" class="num" type="number" min="0" max="10000" />
                    <span class="hint">espera tras abrir</span>
                  </div>
                </div>

                <div class="row" style="margin-top:10px">
                  <input id="bandStopCmd" class="input" placeholder="Comando banda STOP (opcional)" />
                  <input id="bandRunCmd" class="input" placeholder="Comando banda RUN (opcional)" />
                </div>

                <p class="hint" style="margin-top:8px">
                  Nota: tu firmware puede implementar esos comandos luego. Por ahora no afectan si no existen.
                </p>
              </div>

              <div class="box">
                <b>Flujo QR</b>

                <div class="row" style="margin-top:10px">
                  <select id="camSelect" class="input"></select>
                  <button id="btnCamRefresh" class="ghost">Refrescar</button>
                </div>

                <div class="row">
                  <button id="btnStartScan" disabled>Start Cam</button>
                  <button id="btnStopScan" disabled class="ghost">Stop Cam</button>

                  <button id="btnSimTrigger" disabled class="ghost">Simular Sensor</button>
                  <button id="btnRunLastQR" disabled>Ejecutar último QR</button>
                </div>

                <div class="videoWrap">
                  <video id="video" muted playsinline></video>
                </div>

                <div class="kv">
                  <span class="k">QR Raw</span>
                  <span id="qrRaw" class="v mono">-</span>
                </div>
                <div class="kv">
                  <span class="k">ID</span>
                  <span id="qrId" class="v mono">-</span>
                </div>
                <div class="kv">
                  <span class="k">Angles</span>
                  <span id="qrAngles" class="v mono">-</span>
                </div>

                <p class="hint" style="margin-top:8px">
                  Formato QR recomendado (JSON):
                  <span class="mono">{"id":"Fragil","angles":[90,80,70,60,50,40,20]}</span>
                </p>
              </div>
            </div>

            <hr />

            <h2>Programación (Loop continuo)</h2>

            <div class="row">
              <input id="progName" class="input" placeholder="Nombre del punto (opcional)" />
              <button id="btnSaveProg" disabled>Guardar en Programación</button>
              <button id="btnProgOnce" disabled class="ghost">Ejecutar 1 vez</button>
              <button id="btnProgLoop" disabled>Start Loop</button>
              <button id="btnProgStop" disabled class="danger">Stop Loop</button>
              <button id="btnClearProg" disabled class="ghost">Clear</button>
            </div>

            <div class="box">
              <div class="row spaceBetween">
                <b>Lista Programación</b>
                <span class="pill" id="countProg">0</span>
              </div>
              <div id="listProg" class="list"></div>

              <p class="hint" style="margin-top:10px">
                Loop recorre los puntos en orden hasta que presiones STOP o ESC.
              </p>
            </div>
          </div>
        </section>
      </main>
    </div>

  </div>

  <div id="toasts" class="toasts"></div>
`;

/* =========================
   Helpers
========================= */
const $ = (id) => document.getElementById(id);

function logLine(line) {
  const consoleEl = $("console");
  consoleEl.value += line + "\n";
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function clampInt(v, mn, mx) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return mn;
  return Math.min(mx, Math.max(mn, n));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function uid() {
  return Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
}

function escapeHtml(s) {
  return (s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
}

function toast(msg, type = "info") {
  const wrap = $("toasts");
  if (!wrap) return;
  const el = document.createElement("div");
  el.className = `toast ${type === "ok" ? "ok" : type === "warn" ? "warn" : type === "bad" ? "bad" : ""}`;
  el.innerHTML = `<span class="dot"></span><div>${escapeHtml(msg)}</div>`;
  wrap.appendChild(el);

  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(10px)";
    setTimeout(() => el.remove(), 200);
  }, 2200);
}

function setLed(id, mode) {
  const el = $(id);
  if (!el) return;
  el.classList.remove("on", "warn", "busy");
  if (mode) el.classList.add(mode);
}

function updateHudCounts() {
  $("statIda").textContent = String(ida.length);
  $("statReg").textContent = String(regreso.length);
  $("statProg").textContent = String(program.length);
}

function updateHudCmd(line) {
  $("statLastCmd").textContent = line.length > 34 ? (line.slice(0, 34) + "…") : line;
  $("statLastSent").textContent = new Date().toLocaleTimeString();
}

function currentCommandString() {
  return angles.join(" ");
}

function updateCmdPreview() {
  $("cmdPreview").textContent = currentCommandString();
}

function sanitizeList(list) {
  return (Array.isArray(list) ? list : [])
    .filter((p) => p && Array.isArray(p.angles) && p.angles.length === SERVO_COUNT)
    .map((p) => ({
      id: p.id || uid(),
      name: (p.name ?? "").toString(),
      angles: p.angles.map((x) => clampInt(x, 0, 180)),
    }));
}

function saveLocal() {
  const data = {
    angles,
    ida,
    regreso,
    program,
    settings,
    auto: {
      home: autoState.home,
      pick: autoState.pick,
      gripOpen: autoState.gripOpen,
      gripClose: autoState.gripClose,
      dwellPickMs: autoState.dwellPickMs,
      dwellAfterOpenMs: autoState.dwellAfterOpenMs,
      bandStopCmd: autoState.bandStopCmd,
      bandRunCmd: autoState.bandRunCmd,
    }
  };
  localStorage.setItem(LS_KEY, JSON.stringify(data));
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);

    if (Array.isArray(obj.angles) && obj.angles.length === SERVO_COUNT) {
      angles = obj.angles.map((x) => clampInt(x, 0, 180));
    }
    if (Array.isArray(obj.ida)) ida = sanitizeList(obj.ida);
    if (Array.isArray(obj.regreso)) regreso = sanitizeList(obj.regreso);
    if (Array.isArray(obj.program)) program = sanitizeList(obj.program);

    if (obj.settings && typeof obj.settings === "object") {
      settings.throttleMs = clampInt(obj.settings.throttleMs ?? 250, 20, 2000);
      settings.sendOnRelease = !!obj.settings.sendOnRelease;
      settings.interpSteps = clampInt(obj.settings.interpSteps ?? 1, 1, 200);
      settings.pauseMs = clampInt(obj.settings.pauseMs ?? 250, 0, 20000);
    }

    if (obj.auto && typeof obj.auto === "object") {
      if (Array.isArray(obj.auto.home) && obj.auto.home.length === SERVO_COUNT) autoState.home = obj.auto.home.map((x) => clampInt(x, 0, 180));
      if (Array.isArray(obj.auto.pick) && obj.auto.pick.length === SERVO_COUNT) autoState.pick = obj.auto.pick.map((x) => clampInt(x, 0, 180));
      autoState.gripOpen = clampInt(obj.auto.gripOpen ?? 20, 0, 180);
      autoState.gripClose = clampInt(obj.auto.gripClose ?? 90, 0, 180);
      autoState.dwellPickMs = clampInt(obj.auto.dwellPickMs ?? 250, 0, 10000);
      autoState.dwellAfterOpenMs = clampInt(obj.auto.dwellAfterOpenMs ?? 250, 0, 10000);
      autoState.bandStopCmd = (obj.auto.bandStopCmd ?? "band stop").toString();
      autoState.bandRunCmd = (obj.auto.bandRunCmd ?? "band run").toString();
    }
  } catch {
    // ignore
  }
}

/* =========================
   Tabs
========================= */
const tabs = Array.from(document.querySelectorAll(".tab"));
tabs.forEach((t) => {
  t.addEventListener("click", () => {
    tabs.forEach((x) => x.classList.remove("active"));
    t.classList.add("active");

    const key = t.dataset.tab;
    $("tab-manual").classList.toggle("hidden", key !== "manual");
    $("tab-auto").classList.toggle("hidden", key !== "auto");
  });
});

/* =========================
   Serial
========================= */
function setSerialStatus(isConnected) {
  const status = $("serialStatus");
  status.textContent = isConnected ? "Conectado" : "Desconectado";
  status.classList.toggle("ok", isConnected);
  setLed("ledSerial", isConnected ? "on" : null);
}

function setAutoStatus(text) {
  autoState.statusText = text;
  $("autoStatus").textContent = text;

  if (/RUNNING|LOOP/i.test(text)) setLed("ledAuto", "busy");
  else if (/ARMED/i.test(text)) setLed("ledAuto", "on");
  else if (/STOP|WAIT/i.test(text)) setLed("ledAuto", "warn");
  else setLed("ledAuto", null);
}

function setUIConnected(isConnected) {
  $("btnConnect").disabled = isConnected;
  $("btnDisconnect").disabled = !isConnected;
  $("btnSend").disabled = !isConnected;

  $("btnSendNow").disabled = !isConnected || playing || autoState.busy;
  $("btnCenter").disabled = !isConnected || playing || autoState.busy;
  $("btnZero").disabled = !isConnected || playing || autoState.busy;

  $("btnSaveIda").disabled = !isConnected || playing || autoState.busy;
  $("btnSaveReg").disabled = !isConnected || playing || autoState.busy;

  $("btnPlayIda").disabled = !isConnected || ida.length < 2 || playing || autoState.busy;
  $("btnPlayReg").disabled = !isConnected || regreso.length < 2 || playing || autoState.busy;
  $("btnPlayBoth").disabled = !isConnected || ((ida.length < 2) && (regreso.length < 2)) || playing || autoState.busy;
  $("btnStop").disabled = !isConnected || !playing;

  $("btnClearIda").disabled = !isConnected || ida.length === 0 || playing || autoState.busy;
  $("btnClearReg").disabled = !isConnected || regreso.length === 0 || playing || autoState.busy;

  $("btnExport").disabled = (ida.length === 0 && regreso.length === 0);
  $("btnSaveProg").disabled = !isConnected || playing || autoState.busy;
  $("btnProgOnce").disabled = !isConnected || program.length < 2 || playing || autoState.busy;
  $("btnProgLoop").disabled = !isConnected || program.length < 2 || playing || autoState.busy;
  $("btnProgStop").disabled = !isConnected || !autoState.busy;
  $("btnClearProg").disabled = !isConnected || program.length === 0 || playing || autoState.busy;

  $("btnArmAuto").disabled = !isConnected || autoState.armed || autoState.busy;
  $("btnDisarmAuto").disabled = !isConnected || !autoState.armed || autoState.busy;
  $("btnStopAuto").disabled = !isConnected || (!autoState.armed && !autoState.busy);

  $("btnStartScan").disabled = !isConnected || qr.streamOn;
  $("btnStopScan").disabled = !isConnected || !qr.streamOn;
  $("btnSimTrigger").disabled = !isConnected || !autoState.armed || autoState.busy;
  $("btnRunLastQR").disabled = !isConnected || !autoState.lastPayload || autoState.busy;

  $("btnGoHome").disabled = !isConnected || playing || autoState.busy;
  $("btnGoPick").disabled = !isConnected || playing || autoState.busy;
  $("btnSetHomeFromCurrent").disabled = !isConnected || playing || autoState.busy;
  $("btnSetPickFromCurrent").disabled = !isConnected || playing || autoState.busy;

  // Sidebar quick
  $("qConnect").disabled = isConnected;
  $("qDisconnect").disabled = !isConnected;
  $("qHome").disabled = !isConnected || playing || autoState.busy;
  $("qPick").disabled = !isConnected || playing || autoState.busy;
  $("qArm").disabled = !isConnected || autoState.armed || autoState.busy;
  $("qStop").disabled = !isConnected || (!playing && !autoState.busy && !autoState.armed);
}

async function sendLine(line) {
  if (!writer) return;
  updateHudCmd(line);
  const data = new TextEncoder().encode(line + "\n");
  await writer.write(data);
}

function detectTriggerLine(line) {
  // Esto lo ajustarás cuando edites firmware
  // Ejemplos aceptados: "TRIGGER", "SENSOR 1", "OBJ", "OBJECT"
  return /\bTRIGGER\b|\bSENSOR\b|\bOBJ\b|\bOBJECT\b/i.test(line);
}

function handleIncomingLine(line) {
  // Consola ya la muestra, aquí solo detectamos triggers
  if (autoState.armed && !autoState.busy && detectTriggerLine(line)) {
    toast("Trigger recibido (sensor)", "warn");
    onSensorTrigger();
  }
}

async function startReadLoop() {
  if (!reader) return;

  readLoopRunning = true;
  const decoder = new TextDecoder();
  let buffer = "";

  while (readLoopRunning) {
    try {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace("\r", "");
        buffer = buffer.slice(idx + 1);
        if (line.length) {
          logLine(line);
          handleIncomingLine(line);
        }
      }
    } catch {
      break;
    }
  }
}

async function disconnectSerial() {
  try {
    readLoopRunning = false;

    if (reader) {
      try { await reader.cancel(); } catch {}
      try { reader.releaseLock(); } catch {}
    }
    if (writer) {
      try { writer.releaseLock(); } catch {}
    }
    if (port) {
      try { await port.close(); } catch {}
    }
  } finally {
    port = null;
    reader = null;
    writer = null;
    setSerialStatus(false);
    setUIConnected(false);
    toast("Serial desconectado", "warn");
    logLine("[WEB] Desconectado.");
  }
}

$("btnConnect").addEventListener("click", async () => {
  if (!("serial" in navigator)) {
    alert("Web Serial no está disponible. Usa Chrome o Edge.");
    return;
  }

  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });

    writer = port.writable.getWriter();
    reader = port.readable.getReader();

    setSerialStatus(true);
    setUIConnected(true);
    toast("Serial conectado (115200)", "ok");
    logLine("[WEB] Conectado. Baud 115200.");

    startReadLoop();
    await sendLine("show");
  } catch {
    await disconnectSerial();
    alert("No se pudo conectar. Cierra el Serial Monitor del IDE y reintenta.");
  }
});

$("btnDisconnect").addEventListener("click", async () => {
  await disconnectSerial();
});

$("btnSend").addEventListener("click", async () => {
  const cmd = $("txtCmd").value.trim();
  if (!cmd) return;
  await sendLine(cmd);
  $("txtCmd").value = "";
});

/* =========================
   Manual sliders
========================= */
function buildSliders() {
  const wrap = $("sliders");
  wrap.innerHTML = "";
  sliderRangeEls = [];
  sliderNumEls = [];

  for (let i = 0; i < SERVO_COUNT; i++) {
    const row = document.createElement("div");
    row.className = "sliderRow";

    const label = document.createElement("div");
    label.className = "sliderLabel";
    label.textContent = JOINT_LABELS[i];

    const range = document.createElement("input");
    range.type = "range";
    range.min = "0";
    range.max = "180";
    range.step = "1";
    range.value = String(angles[i]);
    range.dataset.idx = String(i);

    const num = document.createElement("input");
    num.type = "number";
    num.min = "0";
    num.max = "180";
    num.step = "1";
    num.className = "num";
    num.value = String(angles[i]);
    num.dataset.idx = String(i);

    const onInput = () => {
      if (playing || autoState.busy) return;
      const idx = Number(range.dataset.idx);
      angles[idx] = clampInt(range.value, 0, 180);
      num.value = String(angles[idx]);
      updateCmdPreview();
      saveLocal();
      scheduleSend();
    };

    range.addEventListener("input", onInput);
    range.addEventListener("change", async () => {
      if (playing || autoState.busy) return;
      if ($("sendOnRelease").checked) await sendAnglesNow();
    });

    num.addEventListener("input", () => {
      if (playing || autoState.busy) return;
      const idx = Number(num.dataset.idx);
      angles[idx] = clampInt(num.value, 0, 180);
      range.value = String(angles[idx]);
      updateCmdPreview();
      saveLocal();
      scheduleSend();
    });

    num.addEventListener("change", async () => {
      if (playing || autoState.busy) return;
      if ($("sendOnRelease").checked) await sendAnglesNow();
    });

    row.appendChild(label);
    row.appendChild(range);
    row.appendChild(num);
    wrap.appendChild(row);

    sliderRangeEls.push(range);
    sliderNumEls.push(num);
  }

  updateCmdPreview();
}

function syncSliders() {
  for (let i = 0; i < SERVO_COUNT; i++) {
    if (sliderRangeEls[i]) sliderRangeEls[i].value = String(angles[i]);
    if (sliderNumEls[i]) sliderNumEls[i].value = String(angles[i]);
  }
}

async function sendAnglesNow() {
  if (!writer || playing || autoState.busy) return;
  await sendLine(currentCommandString());
}

function scheduleSend() {
  if (!writer || playing || autoState.busy) return;
  const ms = clampInt($("throttleMs").value, 20, 2000);

  if (sendTimer) return;
  sendTimer = setTimeout(async () => {
    sendTimer = null;
    if ($("sendOnRelease").checked) return;
    await sendAnglesNow();
  }, ms);
}

/* =========================
   Motion: moveTo (web interpolation opcional)
========================= */
async function moveTo(targetAngles, opts = { updateUI: true }) {
  if (!writer) return;

  const steps = clampInt($("interpSteps").value, 1, 200);
  const start = [...angles];
  const dst = targetAngles.map((x) => clampInt(x, 0, 180));

  if (steps === 1) {
    await sendLine(dst.join(" "));
    angles = [...dst];
    updateCmdPreview();
    if (opts.updateUI) syncSliders();
    return;
  }

  for (let k = 1; k <= steps; k++) {
    if (stopRequested) return;
    const t = k / steps;
    const frame = new Array(SERVO_COUNT);
    for (let i = 0; i < SERVO_COUNT; i++) {
      frame[i] = Math.round(start[i] + (dst[i] - start[i]) * t);
    }
    await sendLine(frame.join(" "));
    angles = frame;
    updateCmdPreview();
    if (opts.updateUI && (k === steps || k % 3 === 0)) syncSliders();
    await sleep(20);
  }
}

/* =========================
   Replica lists (Ida/Reg)
========================= */
function renderLists() {
  $("countIda").textContent = String(ida.length);
  $("countReg").textContent = String(regreso.length);
  $("countProg").textContent = String(program.length);

  updateHudCounts();

  renderOne("listIda", ida, "ida");
  renderOne("listReg", regreso, "regreso");
  renderOne("listProg", program, "prog");

  setUIConnected(!!writer);
  saveLocal();
}

function renderOne(containerId, list, kind) {
  const wrap = $(containerId);
  wrap.innerHTML = "";

  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "listItem";
    empty.innerHTML = `<div class="meta">
      <div class="title">Sin puntos</div>
      <div class="angles mono">Guarda puntos para ejecutar.</div>
    </div>`;
    wrap.appendChild(empty);
    return;
  }

  list.forEach((p, idx) => {
    const item = document.createElement("div");
    item.className = "listItem";

    const name = p.name?.trim() ? p.name.trim() : `${kind.toUpperCase()} ${idx + 1}`;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `
      <div class="title">${idx + 1}. ${escapeHtml(name)}</div>
      <div class="angles mono">${p.angles.join(" ")}</div>
    `;

    const actions = document.createElement("div");
    actions.className = "actions";

    const btnLoad = document.createElement("button");
    btnLoad.textContent = "Cargar";
    btnLoad.disabled = playing || autoState.busy;
    btnLoad.addEventListener("click", () => {
      angles = [...p.angles];
      syncSliders();
      updateCmdPreview();
      saveLocal();
      toast("Cargado a sliders", "ok");
    });

    const btnGo = document.createElement("button");
    btnGo.textContent = "Ir";
    btnGo.disabled = !writer || playing || autoState.busy;
    btnGo.addEventListener("click", async () => {
      await moveTo(p.angles);
      toast("Movimiento enviado", "ok");
    });

    const btnDel = document.createElement("button");
    btnDel.textContent = "Borrar";
    btnDel.className = "danger";
    btnDel.disabled = playing || autoState.busy;
    btnDel.addEventListener("click", () => {
      if (kind === "ida") ida = ida.filter((x) => x.id !== p.id);
      else if (kind === "regreso") regreso = regreso.filter((x) => x.id !== p.id);
      else program = program.filter((x) => x.id !== p.id);
      renderLists();
    });

    actions.appendChild(btnLoad);
    actions.appendChild(btnGo);
    actions.appendChild(btnDel);

    item.appendChild(meta);
    item.appendChild(actions);
    wrap.appendChild(item);
  });
}

/* =========================
   Sequence play (Ida/Reg)
========================= */
async function playSequence(list, label) {
  const pauseMs = clampInt($("pauseMs").value, 0, 20000);

  for (let i = 0; i < list.length; i++) {
    if (stopRequested) return;
    $("playState").textContent = `${label} ${i + 1}/${list.length}`;
    await moveTo(list[i].angles);
    if (stopRequested) return;
    if (pauseMs) await sleep(pauseMs);
  }
}

async function play(mode) {
  if (!writer) return;
  playing = true;
  stopRequested = false;
  setUIConnected(true);

  try {
    if (mode === "ida") await playSequence(ida, "Ida");
    else if (mode === "reg") await playSequence(regreso, "Regreso");
    else {
      if (ida.length) await playSequence(ida, "Ida");
      if (!stopRequested && regreso.length) await playSequence(regreso, "Regreso");
    }
    $("playState").textContent = "Idle";
    toast("Réplica finalizada", "ok");
  } finally {
    playing = false;
    stopRequested = false;
    setUIConnected(!!writer);
  }
}

/* =========================
   AUTO: QR parsing + flow
========================= */
function parseQR(text) {
  const raw = (text ?? "").trim();
  if (!raw) return null;

  // JSON recomendado
  if (raw.startsWith("{")) {
    try {
      const obj = JSON.parse(raw);
      if (!obj || !obj.angles) return null;
      const id = (obj.id ?? "").toString().trim() || "SIN_ID";
      const arr = Array.isArray(obj.angles) ? obj.angles : null;
      if (!arr || arr.length !== SERVO_COUNT) return null;
      return { id, angles: arr.map((x) => clampInt(x, 0, 180)) };
    } catch {
      return null;
    }
  }

  // Formato simple: ID=Fragil;A=90,80,70,60,50,40,20
  const mId = raw.match(/ID\s*=\s*([^;]+)/i);
  const mA = raw.match(/A\s*=\s*([0-9,\s]+)/i);
  if (mA) {
    const id = mId ? mId[1].trim() : "SIN_ID";
    const nums = mA[1].split(",").map((s) => clampInt(s.trim(), 0, 180));
    if (nums.length === SERVO_COUNT) return { id, angles: nums };
  }

  return null;
}

function applyGripper(arr, gripAngle) {
  const out = [...arr];
  out[6] = clampInt(gripAngle, 0, 180);
  return out;
}

async function onSensorTrigger() {
  if (!autoState.armed || autoState.busy) return;

  autoState.waitingForQR = true;
  setAutoStatus("WAITING QR (OBJ)");
  toast("Objeto detectado: esperando QR...", "warn");

  // parar banda (si firmware lo soporta)
  if (autoState.bandStopCmd.trim()) {
    try { await sendLine(autoState.bandStopCmd.trim()); } catch {}
  }

  // si ya hay QR leído, ejecuta de una
  if (qr.lastPayload && !autoState.busy) {
    autoState.waitingForQR = false;
    await runAutoOnce(qr.lastPayload);
  }
}

async function runAutoOnce(payload) {
  if (!payload || !payload.angles) return;
  if (!writer) return;
  if (autoState.busy) return;

  autoState.busy = true;
  stopRequested = false;
  setUIConnected(true);

  setAutoStatus(`RUNNING (${payload.id})`);
  toast(`Auto: ejecutando ${payload.id}`, "ok");

  try {
    // Banda STOP (por si no llegó antes)
    if (autoState.bandStopCmd.trim()) {
      try { await sendLine(autoState.bandStopCmd.trim()); } catch {}
    }

    // HOME (gripper abierto)
    await moveTo(applyGripper(autoState.home, autoState.gripOpen), { updateUI: false });

    // PICK (gripper abierto)
    await moveTo(applyGripper(autoState.pick, autoState.gripOpen), { updateUI: false });

    // Close gripper (manteniendo postura pick)
    await moveTo(applyGripper(autoState.pick, autoState.gripClose), { updateUI: false });
    if (autoState.dwellPickMs) await sleep(autoState.dwellPickMs);

    // DESTINO (gripper cerrado)
    await moveTo(applyGripper(payload.angles, autoState.gripClose), { updateUI: false });

    // Open gripper (en destino)
    await moveTo(applyGripper(payload.angles, autoState.gripOpen), { updateUI: false });
    if (autoState.dwellAfterOpenMs) await sleep(autoState.dwellAfterOpenMs);

    // HOME (abierto)
    await moveTo(applyGripper(autoState.home, autoState.gripOpen), { updateUI: false });

    // Banda RUN
    if (autoState.bandRunCmd.trim()) {
      try { await sendLine(autoState.bandRunCmd.trim()); } catch {}
    }

    setAutoStatus("ARMED");
    toast("Auto: ciclo completado", "ok");
  } catch {
    setAutoStatus("STOP/ERROR");
    toast("Auto: error en ejecución", "bad");
  } finally {
    autoState.busy = false;
    autoState.waitingForQR = false;
    setUIConnected(!!writer);
  }
}

/* =========================
   Camera / ZXing
========================= */
async function refreshCameras() {
  const sel = $("camSelect");
  sel.innerHTML = "";

  try {
    // Pedimos permiso una vez para ver labels
    await navigator.mediaDevices.getUserMedia({ video: true });
  } catch {
    // ok, puede fallar si no da permiso todavía
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === "videoinput");

  if (cams.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No hay cámaras";
    sel.appendChild(opt);
    return;
  }

  cams.forEach((c, i) => {
    const opt = document.createElement("option");
    opt.value = c.deviceId;
    opt.textContent = c.label || `Camera ${i + 1}`;
    sel.appendChild(opt);
  });
}

async function startScan() {
  if (qr.streamOn) return;
  if (!writer) return;

  const video = $("video");
  const deviceId = $("camSelect").value || undefined;

  try {
    setLed("ledCam", "busy");
    setAutoStatus(autoState.armed ? "ARMED (Cam)" : "Idle (Cam)");
    toast("Cámara: iniciando...", "warn");

    qr.controls = await qr.reader.decodeFromVideoDevice(
      deviceId,
      video,
      async (result, err) => {
        // Si no hay QR en ese frame, err existe: lo ignoramos
        if (result) {
          const raw = result.getText();
          const payload = parseQR(raw);

          $("qrRaw").textContent = raw;
          qr.lastRaw = raw;

          if (!payload) {
            $("qrId").textContent = "-";
            $("qrAngles").textContent = "-";
            qr.lastPayload = null;
            toast("QR inválido (formato)", "bad");
            return;
          }

          $("qrId").textContent = payload.id;
          $("qrAngles").textContent = payload.angles.join(" ");
          qr.lastPayload = payload;

          toast(`QR OK: ${payload.id}`, "ok");

          // Si está esperando QR por trigger de sensor, dispara auto
          if (autoState.armed && autoState.waitingForQR && !autoState.busy) {
            autoState.waitingForQR = false;
            await runAutoOnce(payload);
          }

          setUIConnected(!!writer);
        }
      }
    );

    qr.streamOn = true;
    setLed("ledCam", "on");
    toast("Cámara activa", "ok");
    setUIConnected(!!writer);
  } catch {
    qr.streamOn = false;
    setLed("ledCam", null);
    toast("No se pudo iniciar cámara (permisos o dispositivo)", "bad");
    setUIConnected(!!writer);
  }
}

async function stopScan() {
  try {
    if (qr.controls && typeof qr.controls.stop === "function") qr.controls.stop();
  } catch {}
  qr.controls = null;
  qr.streamOn = false;
  setLed("ledCam", null);
  toast("Cámara detenida", "warn");
  setUIConnected(!!writer);
}

/* =========================
   AUTO: Program loop
========================= */
async function runProgramOnce() {
  if (!writer) return;
  if (program.length < 2) return;

  autoState.busy = true;
  setAutoStatus("RUNNING (PROG)");
  setUIConnected(true);

  try {
    const pauseMs = clampInt($("pauseMs").value, 0, 20000);

    for (let i = 0; i < program.length; i++) {
      if (stopRequested) break;
      await moveTo(program[i].angles, { updateUI: false });
      if (pauseMs) await sleep(pauseMs);
    }
  } finally {
    autoState.busy = false;
    setAutoStatus(autoState.armed ? "ARMED" : "Idle");
    setUIConnected(!!writer);
  }
}

async function runProgramLoop() {
  if (!writer) return;
  if (program.length < 2) return;

  autoState.busy = true;
  stopRequested = false;
  setAutoStatus("LOOP (PROG)");
  setUIConnected(true);
  toast("Loop iniciado", "ok");

  try {
    const pauseMs = clampInt($("pauseMs").value, 0, 20000);

    while (!stopRequested) {
      for (let i = 0; i < program.length; i++) {
        if (stopRequested) break;
        await moveTo(program[i].angles, { updateUI: false });
        if (pauseMs) await sleep(pauseMs);
      }
    }
  } finally {
    autoState.busy = false;
    setAutoStatus(autoState.armed ? "ARMED" : "Idle");
    setUIConnected(!!writer);
    toast("Loop detenido", "warn");
  }
}

/* =========================
   Wire UI events
========================= */

// Sidebar quick actions
$("qConnect").addEventListener("click", () => $("btnConnect").click());
$("qDisconnect").addEventListener("click", () => $("btnDisconnect").click());
$("qHome").addEventListener("click", () => $("btnGoHome").click());
$("qPick").addEventListener("click", () => $("btnGoPick").click());
$("qArm").addEventListener("click", () => $("btnArmAuto").click());
$("qStop").addEventListener("click", () => {
  stopRequested = true;
  $("btnStopAuto").click();
  $("btnProgStop").click();
  $("btnStop").click();
  toast("STOP solicitado", "warn");
});

// Manual
$("btnSendNow").addEventListener("click", sendAnglesNow);
$("btnCenter").addEventListener("click", async () => {
  angles = new Array(SERVO_COUNT).fill(90);
  syncSliders();
  updateCmdPreview();
  saveLocal();
  await sendAnglesNow();
});
$("btnZero").addEventListener("click", async () => {
  angles = new Array(SERVO_COUNT).fill(0);
  syncSliders();
  updateCmdPreview();
  saveLocal();
  await sendAnglesNow();
});

// Settings inputs
$("throttleMs").addEventListener("change", () => {
  settings.throttleMs = clampInt($("throttleMs").value, 20, 2000);
  saveLocal();
});
$("sendOnRelease").addEventListener("change", () => {
  settings.sendOnRelease = $("sendOnRelease").checked;
  saveLocal();
});
$("interpSteps").addEventListener("change", () => {
  settings.interpSteps = clampInt($("interpSteps").value, 1, 200);
  saveLocal();
});
$("pauseMs").addEventListener("change", () => {
  settings.pauseMs = clampInt($("pauseMs").value, 0, 20000);
  saveLocal();
});

// Replica save
$("btnSaveIda").addEventListener("click", () => {
  ida.push({ id: uid(), name: $("pointName").value.trim(), angles: [...angles] });
  $("pointName").value = "";
  renderLists();
});
$("btnSaveReg").addEventListener("click", () => {
  regreso.push({ id: uid(), name: $("pointName").value.trim(), angles: [...angles] });
  $("pointName").value = "";
  renderLists();
});
$("btnClearIda").addEventListener("click", () => { ida = []; renderLists(); });
$("btnClearReg").addEventListener("click", () => { regreso = []; renderLists(); });

// Replica play
$("btnPlayIda").addEventListener("click", async () => { if (!playing) await play("ida"); });
$("btnPlayReg").addEventListener("click", async () => { if (!playing) await play("reg"); });
$("btnPlayBoth").addEventListener("click", async () => { if (!playing) await play("both"); });
$("btnStop").addEventListener("click", async () => {
  stopRequested = true;
  $("playState").textContent = "Stopping...";
  await sleep(50);
  $("playState").textContent = "Idle";
});

// Export/Import replica
$("btnExport").addEventListener("click", () => {
  const data = { version: 1, createdAt: new Date().toISOString(), ida, regreso };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "ida_regreso.json";
  a.click();
  URL.revokeObjectURL(a.href);
});
$("btnImport").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const obj = JSON.parse(await file.text());
    ida = sanitizeList(obj.ida);
    regreso = sanitizeList(obj.regreso);
    renderLists();
    toast(`Importado: Ida=${ida.length}, Reg=${regreso.length}`, "ok");
  } catch {
    toast("No se pudo importar JSON", "bad");
  } finally {
    e.target.value = "";
  }
});

// Auto config
$("gripOpen").addEventListener("change", () => { autoState.gripOpen = clampInt($("gripOpen").value, 0, 180); saveLocal(); });
$("gripClose").addEventListener("change", () => { autoState.gripClose = clampInt($("gripClose").value, 0, 180); saveLocal(); });
$("dwellPickMs").addEventListener("change", () => { autoState.dwellPickMs = clampInt($("dwellPickMs").value, 0, 10000); saveLocal(); });
$("dwellAfterOpenMs").addEventListener("change", () => { autoState.dwellAfterOpenMs = clampInt($("dwellAfterOpenMs").value, 0, 10000); saveLocal(); });

$("bandStopCmd").addEventListener("change", () => { autoState.bandStopCmd = $("bandStopCmd").value.trim(); saveLocal(); });
$("bandRunCmd").addEventListener("change", () => { autoState.bandRunCmd = $("bandRunCmd").value.trim(); saveLocal(); });

$("btnSetHomeFromCurrent").addEventListener("click", () => {
  autoState.home = [...angles];
  saveLocal();
  toast("HOME actualizado", "ok");
});
$("btnSetPickFromCurrent").addEventListener("click", () => {
  autoState.pick = [...angles];
  saveLocal();
  toast("PICK actualizado", "ok");
});

$("btnGoHome").addEventListener("click", async () => {
  if (!writer || playing || autoState.busy) return;
  await moveTo(applyGripper(autoState.home, autoState.gripOpen));
  toast("Ir HOME", "ok");
});
$("btnGoPick").addEventListener("click", async () => {
  if (!writer || playing || autoState.busy) return;
  await moveTo(applyGripper(autoState.pick, autoState.gripOpen));
  toast("Ir PICK", "ok");
});

// Auto controls
$("btnArmAuto").addEventListener("click", () => {
  autoState.armed = true;
  setAutoStatus("ARMED");
  toast("Auto armado", "ok");
  setUIConnected(!!writer);
});
$("btnDisarmAuto").addEventListener("click", () => {
  autoState.armed = false;
  autoState.waitingForQR = false;
  setAutoStatus("Idle");
  toast("Auto desarmado", "warn");
  setUIConnected(!!writer);
});
$("btnStopAuto").addEventListener("click", () => {
  stopRequested = true;
  autoState.waitingForQR = false;
  setAutoStatus("STOP");
  toast("STOP Auto", "warn");
  setUIConnected(!!writer);
});

// Camera controls
$("btnCamRefresh").addEventListener("click", async () => {
  await refreshCameras();
  toast("Cámaras refrescadas", "ok");
});

$("btnStartScan").addEventListener("click", startScan);
$("btnStopScan").addEventListener("click", stopScan);

$("btnSimTrigger").addEventListener("click", async () => {
  toast("Simulando trigger...", "warn");
  await onSensorTrigger();
});

$("btnRunLastQR").addEventListener("click", async () => {
  if (!qr.lastPayload) return;
  await runAutoOnce(qr.lastPayload);
});

// Program list
$("btnSaveProg").addEventListener("click", () => {
  program.push({ id: uid(), name: $("progName").value.trim(), angles: [...angles] });
  $("progName").value = "";
  renderLists();
});

$("btnClearProg").addEventListener("click", () => {
  program = [];
  renderLists();
});

$("btnProgOnce").addEventListener("click", async () => {
  stopRequested = false;
  await runProgramOnce();
});

$("btnProgLoop").addEventListener("click", async () => {
  stopRequested = false;
  await runProgramLoop();
});

$("btnProgStop").addEventListener("click", () => {
  stopRequested = true;
  toast("Stop loop solicitado", "warn");
});

// Raw command shortcuts + ESC
$("txtCmd").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    $("btnSend").click();
  }
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    stopRequested = true;
    toast("STOP (ESC)", "warn");
  }
});

/* =========================
   Boot
========================= */
loadLocal();

// Apply loaded settings to UI
$("throttleMs").value = String(settings.throttleMs);
$("sendOnRelease").checked = settings.sendOnRelease;
$("interpSteps").value = String(settings.interpSteps);
$("pauseMs").value = String(settings.pauseMs);

$("gripOpen").value = String(autoState.gripOpen);
$("gripClose").value = String(autoState.gripClose);
$("dwellPickMs").value = String(autoState.dwellPickMs);
$("dwellAfterOpenMs").value = String(autoState.dwellAfterOpenMs);
$("bandStopCmd").value = autoState.bandStopCmd;
$("bandRunCmd").value = autoState.bandRunCmd;

buildSliders();
syncSliders();
updateCmdPreview();
renderLists();

setSerialStatus(false);
setAutoStatus("Idle");
setLed("ledCam", null);
setUIConnected(false);

refreshCameras().catch(() => {});
logLine("[WEB] Listo. Conecta serial para habilitar controles.");
