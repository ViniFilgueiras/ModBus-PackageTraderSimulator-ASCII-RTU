// =============================================================
//  app.js  -  liga a interface ao nucleo Modbus.
//
//  Estrategia:
//   1) Tenta carregar o C++ compilado para WebAssembly (modbus.js).
//   2) Se nao existir ainda, usa o espelho em JavaScript (modbus-core.js).
//  Em ambos os casos a interface se comporta igual.
// =============================================================

let core = null;       // adaptador unificado (WASM ou JS)
let usingWasm = false;

// ---------- Adaptador para a versao C++ (WASM) ----------
async function tryLoadWasm() {
  if (typeof createModbusModule !== "function") return null; // modbus.js ausente
  const Module = await createModbusModule();

  const _write = Module.cwrap("writeSingleRegister", "number", ["number", "number"]);
  const _read  = Module.cwrap("readHoldingRegisters", "number", ["number", "number"]);
  const _getReg = Module.cwrap("getRegister", "number", ["number"]);
  const _count  = Module.cwrap("registerCount", "number", []);
  const _frameP = Module.cwrap("getFrameBuffer", "number", []);
  const _frameN = Module.cwrap("getFrameLength", "number", []);
  const _explP  = Module.cwrap("getExplainBuffer", "number", []);
  const _asciiP = Module.cwrap("getAsciiBuffer", "number", []);
  const _setMode = Module.cwrap("setMode", null, ["number"]);

  // Acessa a memoria do WASM de forma robusta: usa HEAPU8 se o build
  // o expos; senao, le direto do buffer da memoria (wasmMemory/asm.memory).
  function heap() {
    if (Module.HEAPU8) return Module.HEAPU8;
    const mem =
      (Module.wasmMemory && Module.wasmMemory.buffer) ||
      (Module.asm && Module.asm.memory && Module.asm.memory.buffer);
    if (mem) return new Uint8Array(mem);
    throw new Error("Memoria do WASM inacessivel (exporte HEAPU8 no emcc)");
  }

  function frameBytes() {
    const h = heap(), p = _frameP(), n = _frameN(), out = [];
    for (let i = 0; i < n; i++) out.push(h[p + i]);
    return out;
  }
  function explain() { return Module.UTF8ToString(_explP()); }
  function asciiFrame() { return Module.UTF8ToString(_asciiP()); }

  return {
    NUM_REGS: _count(),
    setMode(m) { _setMode(m); },
    write(addr, value) {
      const code = _write(addr, value);
      if (code !== 0) return { error: "Erro C++ codigo " + code };
      return { frame: frameBytes(), ascii: asciiFrame(), explain: explain() };
    },
    read(addr, count) {
      const code = _read(addr, count);
      if (code !== 0) return { error: "Erro C++ codigo " + code };
      return { frame: frameBytes(), ascii: asciiFrame(), explain: explain() };
    },
    registers() {
      const out = [];
      for (let i = 0; i < _count(); i++) out.push(_getReg(i));
      return out;
    },
  };
}

// ---------- Adaptador para o espelho JavaScript ----------
function jsAdapter() {
  const M = window.ModbusJS;
  return {
    NUM_REGS: M.NUM_REGS,
    setMode() { /* o espelho JS sempre gera os dois formatos */ },
    write(addr, value) {
      const r = M.writeSingleRegister(addr, value);
      return r.error ? r : { frame: r.frame, ascii: r.ascii, explain: r.explain };
    },
    read(addr, count) {
      const r = M.readHoldingRegisters(addr, count);
      return r.error ? r : { frame: r.frame, ascii: r.ascii, explain: r.explain };
    },
    registers() { return M.getRegisters(); },
  };
}

// ---------- Elementos ----------
const el = (id) => document.getElementById(id);
const regGrid = el("regGrid");
const log = el("log");
const packet = el("packet");

function hex(bytes) {
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

// Modo de transmissao atual: "RTU" ou "ASCII".
let mode = "RTU";

// Deixa a string ASCII visivel trocando CR/LF por marcadores legiveis.
function asciiVisible(s) {
  return s.replace(/\r/g, "<CR>").replace(/\n/g, "<LF>");
}

// ---------- Render dos registradores ----------
function renderRegs(highlight, klass) {
  const vals = core.registers();
  regGrid.innerHTML = "";
  vals.forEach((v, i) => {
    const d = document.createElement("div");
    d.className = "reg" + (highlight && highlight.includes(i) ? " " + klass : "");
    d.innerHTML = `<div class="idx">R${i}</div><div class="val">${v}</div>`;
    regGrid.appendChild(d);
  });
}

// ---------- Animacao do pacote no barramento ----------
function animatePacket(text, dir) {
  packet.textContent = text;
  packet.className = "packet " + (dir === "right" ? "go-right" : "go-left");
  // reinicia a animacao
  void packet.offsetWidth;
}

// ---------- Registro no monitor ----------
function logEntry(kind, dirLabel, result, desc) {
  const empty = log.querySelector(".log__empty");
  if (empty) empty.remove();
  const e = document.createElement("div");
  e.className = "entry " + kind;
  const ts = new Date().toLocaleTimeString("pt-BR");

  let frameHtml = "";
  if (result && result.frame) {
    if (mode === "ASCII") {
      frameHtml = `<div class="bytes">${asciiVisible(result.ascii)}</div>`;
    } else {
      frameHtml = `<div class="bytes">${hex(result.frame)}</div>`;
    }
  }

  e.innerHTML =
    `<div class="dir">${dirLabel} ` +
    `<span class="modetag">[${mode}]</span> ` +
    `<span style="color:var(--ink-soft);font-weight:400">${ts}</span></div>` +
    frameHtml +
    `<div class="desc">${desc}</div>`;
  log.prepend(e);
}

// ---------- Acoes ----------
function doWrite() {
  const addr = parseInt(el("wAddr").value, 10);
  const value = parseInt(el("wValue").value, 10);
  const r = core.write(addr, value);
  if (r.error) { logEntry("err", "✕ ESCRITA RECUSADA", null, r.error); return; }

  animatePacket(`06 → R${addr}=${value}`, "right");
  setTimeout(() => {
    renderRegs([addr], "flash");
    animatePacket("06 ✓ eco", "left");
    logEntry("write", "▶ MESTRE → ESCRAVO  (FC06 escrita)", r, r.explain);
  }, 900);
}

function doRead() {
  const addr = parseInt(el("rAddr").value, 10);
  const count = parseInt(el("rCount").value, 10);
  const r = core.read(addr, count);
  if (r.error) { logEntry("err", "✕ LEITURA RECUSADA", null, r.error); return; }

  animatePacket(`03 → ler ${count}`, "right");
  setTimeout(() => {
    const idx = [];
    for (let i = 0; i < count; i++) idx.push(addr + i);
    renderRegs(idx, "read");
    animatePacket("03 ◀ dados", "left");
    logEntry("read", "◀ ESCRAVO → MESTRE  (FC03 leitura)", r, r.explain);
  }, 900);
}

// ---------- Inicializacao ----------
async function init() {
  try {
    const w = await tryLoadWasm();
    if (w) { core = w; usingWasm = true; }
  } catch (e) { console.warn("WASM indisponivel:", e); }
  if (!core) core = jsAdapter();

  el("engineStatus").textContent = usingWasm
    ? "motor: C++ / WebAssembly ✓"
    : "motor: JavaScript (espelho do C++)";

  renderRegs([], "");
  el("btnWrite").addEventListener("click", doWrite);
  el("btnRead").addEventListener("click", doRead);
  el("btnClear").addEventListener("click", () => {
    log.innerHTML = '<div class="log__empty">Monitor limpo.</div>';
  });

  // Botao de troca RTU <-> ASCII
  const btnMode = el("btnMode");
  function refreshModeButton() {
    btnMode.textContent = "Modo: " + mode;
    btnMode.dataset.mode = mode;
  }
  btnMode.addEventListener("click", () => {
    mode = (mode === "RTU") ? "ASCII" : "RTU";
    if (core.setMode) core.setMode(mode === "ASCII" ? 1 : 0);
    refreshModeButton();
    logEntry("info", "⚙ Modo de transmissao alterado", null,
      mode === "ASCII"
        ? "ASCII: cada byte vira 2 caracteres hex, frame entre ':' e <CR><LF>, checksum LRC."
        : "RTU: bytes binarios crus, checksum CRC16, sem delimitadores.");
  });
  refreshModeButton();
}

init();
