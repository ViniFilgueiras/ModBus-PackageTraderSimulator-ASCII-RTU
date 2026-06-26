// =============================================================
//  app.js - Versão Final Completa com Escrita Dinâmica Diferenciada
// =============================================================

let core = null;       
let usingWasm = false;

async function tryLoadWasm() {
  if (typeof createModbusModule !== "function") return null; 
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

  function heap() {
    if (Module.HEAPU8) return Module.HEAPU8;
    const mem =
      (Module.wasmMemory && Module.wasmMemory.buffer) ||
      (Module.asm && Module.asm.memory && Module.asm.memory.buffer);
    if (mem) return new Uint8Array(mem);
    throw new Error("Memoria do WASM inacessivel");
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

function jsAdapter() {
  const M = window.ModbusJS;
  return {
    NUM_REGS: M.NUM_REGS,
    setMode() {},
    write(addr, value) {
      const r = M.writeSingleRegister(addr, value);
      return r.error ? r : { 
        frame: r.frame, 
        ascii: r.ascii, 
        explain: r.explain, 
        isException: r.isException,
        func: r.func,
        reqFrame: r.reqFrame,
        reqAscii: r.reqAscii
      };
    },
    read(addr, count) {
      const r = M.readHoldingRegisters(addr, count);
      return r.error ? r : { 
        frame: r.frame, 
        ascii: r.ascii, 
        explain: r.explain, 
        isException: r.isException,
        reqFrame: r.reqFrame, 
        reqAscii: r.reqAscii 
      };
    },
    registers() { return M.getRegisters(); },
  };
}

const el = (id) => document.getElementById(id);
const regGrid = el("regGrid");
const log = el("log");
const packet = el("packet");

function hex(bytes) {
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

let mode = "RTU";

function asciiVisible(s) {
  return s.replace(/\r/g, "<CR>").replace(/\n/g, "<LF>");
}

function parseCommercialAddress(val) {
  if (val >= 40001) return val - 40001; 
  if (val >= 30001) return val - 30001; 
  if (val >= 10001) return val - 10001; 
  if (val >= 13 && val <= 16) return val - 1;     
  return val; 
}

function renderRegs(highlight, klass) {
  const vals = core.registers();
  regGrid.innerHTML = "";
  vals.forEach((v, i) => {
    const d = document.createElement("div");
    d.className = "reg" + (highlight && highlight.includes(i) ? " " + klass : "");
    
    let label = `R${i}`;
    
    if (i >= 0 && i <= 3) {
      d.style.borderColor = "var(--amber)"; 
      label = String(40001 + i);
    } else if (i >= 4 && i <= 7) {
      d.style.borderColor = "var(--cyan)";  
      label = String(30001 + i);
    } else if (i >= 8 && i <= 11) {
      d.style.borderColor = "var(--ink-soft)"; 
      label = String(10001 + i);
    } else if (i >= 12 && i <= 15) {
      d.style.borderColor = "var(--green)"; 
      label = String(i + 1).padStart(5, '0');
    }
    
    d.innerHTML = `<div class="idx">${label}</div><div class="val">${v}</div>`;
    regGrid.appendChild(d);
  });
}

function animatePacket(text, dir) {
  packet.textContent = text;
  packet.className = "packet " + (dir === "right" ? "go-right" : "go-left");
  void packet.offsetWidth;
}

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
    `<div class="desc" style="white-space: pre-wrap;">${desc}</div>`;
  log.prepend(e);
}

// ---------- Ações de Escrita Diferenciadas ----------
function doWrite() {
  const rawInput = el("wAddr").value;
  const addr = parseCommercialAddress(rawInput); 
  const value = parseInt(el("wValue").value, 10);
  const r = core.write(addr, value);
  if (r.error) { logEntry("err", "✕ ESCRITA RECUSADA", null, r.error); return; }

  // Descobre qual seria o FC de escrita correto para rotular os títulos na tela
  let fc = (addr >= 12 && addr <= 15) ? 0x05 : 0x06;
  const fcHex = fc.toString(16).padStart(2, "0").toUpperCase();

  // 1. Registra a Ida com o código dinâmico (FC05 ou FC06)
  const reqResult = { frame: r.reqFrame, ascii: r.reqAscii };
  logEntry("write", `▶ MESTRE → ESCRAVO  (FC${fcHex} Solicitação)`, reqResult, `Mestre enviando comando de escrita para o endereço mapeado.`);

  animatePacket(`${fcHex} → R[${addr}]=${value}`, "right");
  setTimeout(() => {
    if (r.isException) {
      const excHex = r.func.toString(16).toUpperCase(); // Pega 85 ou 86 da resposta
      animatePacket(`${excHex} ✕ erro`, "left");
      logEntry("err", `◀ ESCRAVO → MESTRE  (FC${excHex} Resposta com Exceção)`, r, r.explain);
    } else {
      renderRegs([addr], "flash");
      animatePacket(`${fcHex} ✓ eco`, "left");
      logEntry("write", `◀ ESCRAVO → MESTRE  (FC${fcHex} Resposta/Eco)`, r, r.explain);
    }
  }, 900);
}

// ---------- Ações de Leitura ----------
function doRead() {
  const rawInput = el("rAddr").value;
  const addr = parseCommercialAddress(rawInput); 
  const count = parseInt(el("rCount").value, 10);
  const r = core.read(addr, count);
  if (r.error) { logEntry("err", "✕ LEITURA RECUSADA", null, r.error); return; }

  let fc = 0x03;
  if (addr >= 4 && addr <= 7) fc = 0x04;
  if (addr >= 8 && addr <= 11) fc = 0x02;
  if (addr >= 12 && addr <= 15) fc = 0x01;
  const fcHex = fc.toString(16).padStart(2, "0").toUpperCase();

  const reqResult = { frame: r.reqFrame, ascii: r.reqAscii };
  logEntry("read", `▶ MESTRE → ESCRAVO  (FC${fcHex} Solicitação)`, reqResult, `Mestre solicitando leitura a partir do endereço mapeado (Offset Enviado no Frame: ${addr}).`);

  animatePacket(`${fcHex} → ler`, "right");
  setTimeout(() => {
    if (r.isException) {
      const excHex = (fc + 0x80).toString(16).toUpperCase();
      animatePacket(`${excHex} ✕ erro`, "left");
      logEntry("err", `◀ ESCRAVO → MESTRE  (FC${excHex} Resposta com Exceção)`, r, r.explain);
    } else {
      const idx = [];
      for (let i = 0; i < count; i++) idx.push(addr + i);
      renderRegs(idx, "read");
      animatePacket(`${fcHex} ◀ dados`, "left");
      logEntry("read", `◀ ESCRAVO → MESTRE  (FC${fcHex} Resposta)`, r, r.explain);
    }
  }, 900);
}

async function init() {
  try {
    const w = await tryLoadWasm();
    if (w) { core = w; usingWasm = true; }
  } catch (e) { console.warn("WASM indisponivel:", e); }
  if (!core) core = jsAdapter();

  el("engineStatus").textContent = usingWasm
    ? "motor: C++ / WebAssembly ✓"
    : "motor: JavaScript (espelho do C++)";

  const existingLegend = el("modbusLegend");
  if (!existingLegend) {
    const legend = document.createElement("div");
    legend.id = "modbusLegend";
    legend.style.display = "flex";
    legend.style.flexWrap = "wrap";
    legend.style.gap = "0.8rem";
    legend.style.justifyContent = "start";
    legend.style.marginBottom = "1.2rem";
    legend.style.padding = "0.6rem 0.8rem";
    legend.style.background = "var(--bg-2)";
    legend.style.border = "1px solid var(--line)";
    legend.style.borderRadius = "6px";
    legend.style.fontSize = "0.68rem";
    legend.style.fontFamily = "var(--mono)";
    legend.style.color = "var(--ink-soft)";

    const items = [
      { color: "var(--amber)", text: "4x Holding (FC03/FC06)" },
      { color: "var(--cyan)", text: "3x Input Regs (FC04 R/O)" },
      { color: "var(--ink-soft)", text: "1x Discrete (FC02 R/O)" },
      { color: "var(--green)", text: "0x Coils (FC01/FC05)" }
    ];

    items.forEach(item => {
      const d = document.createElement("div");
      d.style.display = "flex";
      d.style.alignItems = "center";
      d.style.gap = "0.35rem";
      d.innerHTML = `<span style="display:inline-block; width:9px; height:9px; background:${item.color}; border-radius:2px;"></span><span>${item.text}</span>`;
      legend.appendChild(d);
    });

    regGrid.parentNode.insertBefore(legend, regGrid);
  }

  renderRegs([], "");
  el("btnWrite").addEventListener("click", doWrite);
  el("btnRead").addEventListener("click", doRead);
  el("btnClear").addEventListener("click", () => {
    log.innerHTML = '<div class="log__empty">Monitor limpo.</div>';
  });

  const btnMode = el("btnMode");
  function refreshModeButton() {
    btnMode.textContent = "Modo: " + mode;
    btnMode.dataset.mode = mode;
  }
  btnMode.addEventListener("click", () => {
    mode = (mode === "RTU") ? "ASCII" : "RTU";
    if (core.setMode) core.setMode(mode === "ASCII" ? 1 : 0);
    refreshModeButton();
    logEntry("info", "⚙ Modo de transmissão alterado", null,
      mode === "ASCII"
        ? "ASCII: cada byte vira 2 caracteres hex, frame entre ':' e <CR><LF>, checksum LRC."
        : "RTU: bytes binários crus, checksum CRC16, sem delimitadores.");
  });
  refreshModeButton();
}

init();