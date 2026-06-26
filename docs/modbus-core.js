// =============================================================
//  modbus-core.js - Versão Final (FC05 e FC06 Completamente Diferenciados)
// =============================================================

const NUM_REGS = 16;
const SLAVE_ID = 1;

const holdingRegisters = new Uint16Array(NUM_REGS);
// Registradores originais (Holding 4x)
holdingRegisters[0] = 100;
holdingRegisters[1] = 200;
holdingRegisters[2] = 300;
holdingRegisters[3] = 400;

// Valores para simular os novos registradores (Zonas de Leitura)
holdingRegisters[4] = 55;    // Input Register (3x) - Somente Leitura
holdingRegisters[5] = 1023;  // Input Register (3x) - Somente Leitura
holdingRegisters[6] = 0;
holdingRegisters[7] = 0;

holdingRegisters[8] = 1;     // Discrete Input (1x) - Somente Leitura
holdingRegisters[9] = 0;     // Discrete Input (1x) - Somente Leitura
holdingRegisters[10] = 1;
holdingRegisters[11] = 0;

holdingRegisters[12] = 1;    // Bobina (Coil 0x) - Leitura e Escrita
holdingRegisters[13] = 0;    // Bobina (Coil 0x) - Leitura e Escrita
holdingRegisters[14] = 0;
holdingRegisters[15] = 0;

// Helper para converter o índice interno em endereço comercial clássico
function getCommercialLabel(i) {
  if (i >= 0 && i <= 3)   return `4000${i + 1}`;
  if (i >= 4 && i <= 7)   return `3000${i + 1}`;
  if (i >= 8 && i <= 11)  return `1000${i + 1}`;
  if (i >= 12 && i <= 15) return `0001${i + 1}`;
  return `R${i}`;
}

// ---- CRC16 padrao Modbus (poli 0xA001, init 0xFFFF) ----
function modbusCRC16(bytes) {
  let crc = 0xFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let b = 0; b < 8; b++) {
      if (crc & 0x0001) { crc >>= 1; crc ^= 0xA001; }
      else { crc >>= 1; }
    }
  }
  return crc & 0xFFFF;
}

function appendCRC(arr) {
  const crc = modbusCRC16(arr);
  arr.push(crc & 0xFF);          // CRC low
  arr.push((crc >> 8) & 0xFF);   // CRC high
  return crc;
}

// ---- LRC padrao Modbus ASCII ----
function modbusLRC(bytes) {
  let lrc = 0;
  for (let i = 0; i < bytes.length; i++) lrc = (lrc + bytes[i]) & 0xFF;
  return ((-lrc) & 0xFF);
}

function buildAsciiFrame(dataBytes) {
  const hex2 = (b) => b.toString(16).toUpperCase().padStart(2, "0");
  const lrc = modbusLRC(dataBytes);
  let s = ":";
  for (const b of dataBytes) s += hex2(b);
  s += hex2(lrc) + "\r\n";
  return s;
}

// ---- FUNÇÃO DE ESCRITA ADAPTATIVA (FC05 / FC06) ----
function writeSingleRegister(addr, value) {
  const safeAddr = Math.max(0, Math.min(65535, addr));
  const safeValue = Math.max(0, Math.min(65535, value));

  // --- DETERMINA O CÓDIGO DE FUNÇÃO REAL DE ESCRITA ---
  let fc = 0x06; // Padrão: Holding Register (4x)
  let nomeFuncao = "FUNÇÃO 0x06 - Escrever Registrador Único (4x)";
  
  if (addr >= 12 && addr <= 15) {
    fc = 0x05; // Bobina única (0x Coil)
    nomeFuncao = "FUNÇÃO 0x05 - Escrever Bobina Única (0x - Coil)";
  }

  // Regra do protocolo real para FC05: Ligado = 0xFF00 | Desligado = 0x0000
  let valHigh = (safeValue >> 8) & 0xFF;
  let valLow = safeValue & 0xFF;
  
  if (fc === 0x05) {
    if (value === 1) {
      valHigh = 0xFF;
      valLow = 0x00;
    } else if (value === 0) {
      valHigh = 0x00;
      valLow = 0x00;
    }
  }

  // 1. Monta sempre o Frame de Requisição (Ida do Mestre)
  const req = [
    SLAVE_ID, fc,
    (safeAddr >> 8) & 0xFF, safeAddr & 0xFF,
    valHigh, valLow
  ];
  const reqCrc = modbusCRC16(req);
  req.push(reqCrc & 0xFF);
  req.push((reqCrc >> 8) & 0xFF);
  const reqAscii = buildAsciiFrame(req.slice(0, req.length - 2));

  // EXCEÇÃO 1: Endereço totalmente fora do mapa lógico (0..15)
  if (addr < 0 || addr >= NUM_REGS) {
    const resp = [SLAVE_ID, fc + 0x80, 0x02]; // FC Dinâmico + 80
    const crc = appendCRC(resp);
    return {
      isException: true,
      func: fc + 0x80,
      frame: resp,
      ascii: buildAsciiFrame(resp.slice(0, resp.length - 2)),
      crc,
      reqFrame: req,
      reqAscii: reqAscii,
      explain:
        `✕ RESP_EXCEÇÃO (Erro Modbus 0x${(fc + 0x80).toString(16).toUpperCase()})\n` +
        `Escravo ID: ${SLAVE_ID}  |  Código Modbus: 02 (Illegal Data Address)\n` +
        `Falha: O endereço requisitado (Offset Decimal: ${addr}) não existe neste equipamento.`,
    };
  }

  // EXCEÇÃO 2: Escrita proibida em zonas Read-Only (3x ou 1x)
  if (addr >= 4 && addr <= 11) {
    const resp = [SLAVE_ID, 0x86, 0x02]; 
    const crc = appendCRC(resp);
    return {
      isException: true,
      func: 0x86,
      frame: resp,
      ascii: buildAsciiFrame(resp.slice(0, resp.length - 2)),
      crc,
      reqFrame: req,
      reqAscii: reqAscii,
      explain:
        `✕ RESP_EXCEÇÃO (Erro Modbus 0x86)\n` +
        `Escravo ID: ${SLAVE_ID}  |  Código Modbus: 02 (Illegal Data Address)\n` +
        `Falha: Escrita recusada no endereço ${getCommercialLabel(addr)} (Zona protegida de Somente Leitura).`,
    };
  }

  // EXCEÇÃO 3: Valor inválido para binários (Coils 0x -> FC05 exige estritamente 0 ou 1)
  if (fc === 0x05 && value !== 0 && value !== 1) {
    const resp = [SLAVE_ID, 0x85, 0x03]; // 0x05 + 0x80 = 0x85 | Erro 03 (Illegal Data Value)
    const crc = appendCRC(resp);
    return {
      isException: true,
      func: 0x85,
      frame: resp,
      ascii: buildAsciiFrame(resp.slice(0, resp.length - 2)),
      crc,
      reqFrame: req,
      reqAscii: reqAscii,
      explain:
        `✕ RESP_EXCEÇÃO (Erro Modbus 0x85)\n` +
        `Escravo ID: ${SLAVE_ID}  |  Código Modbus: 03 (Illegal Data Value)\n` +
        `Falha: Valor binário inválido (${value}) enviado para a bobina ${getCommercialLabel(addr)}.\n` +
        `Zonas discretas de Coil só aceitam estritamente 0 (Desligado) ou 1 (Ligado).`,
    };
  }

  // Grava a alteração na memória lúdica do escravo
  holdingRegisters[addr] = value; 

  return {
    isException: false,
    func: fc,
    frame: req, // A resposta bem sucedida do FC05/FC06 é o eco idêntico da requisição                 
    ascii: reqAscii,
    crc: reqCrc,
    reqFrame: req,
    reqAscii: reqAscii,
    explain:
      `${nomeFuncao}\n` +
      `Escravo ID: ${SLAVE_ID}  |  Endereço PLC: ${getCommercialLabel(addr)} (Offset: ${addr})  |  Valor: ${value}\n` +
      `O mestre enviou a formatação correta e o escravo aplicou a alteração na memória.`,
  };
}

// ---- FC 0x03 - Read Holding Registers ----
function readHoldingRegisters(addr, count) {
  const safeAddr = Math.max(0, Math.min(65535, addr));
  const safeCount = Math.max(0, Math.min(65535, count));

  let fc = 0x03; 
  let nomeFuncao = "FUNCAO 0x03 - Ler Holding Registers (4x)";
  
  if (addr >= 4 && addr <= 7) {
    fc = 0x04; 
    nomeFuncao = "FUNCAO 0x04 - Ler Input Registers (3x - Analógicos)";
  } else if (addr >= 8 && addr <= 11) {
    fc = 0x02; 
    nomeFuncao = "FUNCAO 0x02 - Ler Discrete Inputs (1x - Digitais)";
  } else if (addr >= 12 && addr <= 15) {
    fc = 0x01; 
    nomeFuncao = "FUNCAO 0x01 - Ler Coils (0x - Bobinas)";
  }

  const req = [
    SLAVE_ID, fc,
    (safeAddr >> 8) & 0xFF, safeAddr & 0xFF,
    (safeCount >> 8) & 0xFF, safeCount & 0xFF
  ];
  const reqCrc = modbusCRC16(req);
  req.push(reqCrc & 0xFF);
  req.push((reqCrc >> 8) & 0xFF);
  const reqAscii = buildAsciiFrame(req.slice(0, req.length - 2));

  if (addr < 0 || count < 1 || (addr + count) > NUM_REGS) {
    const resp = [SLAVE_ID, fc + 0x80, 0x02];
    const crc = appendCRC(resp);
    return {
      isException: true,
      func: fc + 0x80,
      frame: resp,
      ascii: buildAsciiFrame(resp.slice(0, resp.length - 2)),
      crc,
      reqFrame: req,
      reqAscii: reqAscii,
      explain:
        `✕ RESP_EXCEÇÃO (Erro Modbus 0x${(fc + 0x80).toString(16).toUpperCase()})\n` +
        `Escravo ID: ${SLAVE_ID}  |  Código Modbus: 02 (Illegal Data Address)\n` +
        `Falha: A solicitação estourou a faixa de memória permitida para esta tabela.`,
    };
  }

  const resp = [SLAVE_ID, fc, count * 2];
  const valores = [];
  for (let i = 0; i < count; i++) {
    const v = holdingRegisters[addr + i];
    valores.push(v);
    resp.push((v >> 8) & 0xFF);
    resp.push(v & 0xFF);
  }
  const crc = appendCRC(resp);

  return {
    isException: false,
    func: fc,
    frame: resp,
    ascii: buildAsciiFrame(resp.slice(0, resp.length - 2)),
    crc,
    valores,
    reqFrame: req,
    reqAscii: reqAscii,
    explain:
      `${nomeFuncao}\n` +
      `Escravo ID: ${SLAVE_ID}  |  Início PLC: ${getCommercialLabel(addr)} (Offset: ${addr})  |  Quantidade: ${count}\n` +
      `Valores retornados: ${valores.join(" ")}`,
  };
}

function getRegisters() { return Array.from(holdingRegisters); }

window.ModbusJS = {
  NUM_REGS, SLAVE_ID,
  writeSingleRegister, readHoldingRegisters, getRegisters, modbusCRC16,
};