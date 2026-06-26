// =============================================================
//  modbus-core.js
//  Espelho em JavaScript da MESMA logica do modbus.cpp.
//  Serve para o site funcionar imediatamente (sem compilar nada).
//  Quando voce compilar o C++ para WASM, o site usa o C++ no lugar
//  deste arquivo automaticamente (ver app.js).
//
//  Mantenha esta logica identica ao modbus.cpp para fins didaticos.
// =============================================================

const NUM_REGS = 16;
const SLAVE_ID = 1;

const holdingRegisters = new Uint16Array(NUM_REGS);
holdingRegisters[0] = 100;
holdingRegisters[1] = 200;
holdingRegisters[2] = 300;
holdingRegisters[3] = 400;

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

// ---- LRC padrao Modbus ASCII (soma dos bytes, complemento de 2, 8 bits) ----
function modbusLRC(bytes) {
  let lrc = 0;
  for (let i = 0; i < bytes.length; i++) lrc = (lrc + bytes[i]) & 0xFF;
  return ((-lrc) & 0xFF);
}

// ---- Converte bytes de dados (sem CRC) em frame ASCII ":...<CR><LF>" ----
function buildAsciiFrame(dataBytes) {
  const hex2 = (b) => b.toString(16).toUpperCase().padStart(2, "0");
  const lrc = modbusLRC(dataBytes);
  let s = ":";
  for (const b of dataBytes) s += hex2(b);
  s += hex2(lrc) + "\r\n";
  return s;
}

// ---- FC 0x06 - Write Single Register ----
function writeSingleRegister(addr, value) {
  if (addr < 0 || addr >= NUM_REGS) return { error: "Endereco invalido" };
  if (value < 0 || value > 0xFFFF)  return { error: "Valor fora de 0..65535" };

  const req = [
    SLAVE_ID, 0x06,
    (addr >> 8) & 0xFF, addr & 0xFF,
    (value >> 8) & 0xFF, value & 0xFF,
  ];
  const crc = appendCRC(req);

  holdingRegisters[addr] = value; // o escravo grava

  return {
    func: 0x06,
    frame: req,                 // a resposta do FC06 e o eco da requisicao
    ascii: buildAsciiFrame(req.slice(0, req.length - 2)),
    crc,
    explain:
      `FUNCAO 0x06 - Escrever Registrador Unico\n` +
      `Escravo ID: ${SLAVE_ID}  |  Registrador: ${addr}  |  Valor: ${value}\n` +
      `CRC16: 0x${crc.toString(16).toUpperCase().padStart(4, "0")}\n` +
      `O escravo gravou o valor e devolveu o mesmo frame como confirmacao.`,
  };
}

// ---- FC 0x03 - Read Holding Registers ----
function readHoldingRegisters(addr, count) {
  if (count < 1 || count > NUM_REGS)       return { error: "Quantidade invalida" };
  if (addr < 0 || addr + count > NUM_REGS) return { error: "Faixa fora dos limites" };

  const resp = [SLAVE_ID, 0x03, count * 2];
  const valores = [];
  for (let i = 0; i < count; i++) {
    const v = holdingRegisters[addr + i];
    valores.push(v);
    resp.push((v >> 8) & 0xFF);
    resp.push(v & 0xFF);
  }
  const crc = appendCRC(resp);

  return {
    func: 0x03,
    frame: resp,
    ascii: buildAsciiFrame(resp.slice(0, resp.length - 2)),
    crc,
    valores,
    explain:
      `FUNCAO 0x03 - Ler Registradores\n` +
      `Escravo ID: ${SLAVE_ID}  |  Inicio: ${addr}  |  Quantidade: ${count}\n` +
      `Valores lidos: ${valores.join(" ")}\n` +
      `CRC16: 0x${crc.toString(16).toUpperCase().padStart(4, "0")}`,
  };
}

function getRegisters() { return Array.from(holdingRegisters); }

window.ModbusJS = {
  NUM_REGS, SLAVE_ID,
  writeSingleRegister, readHoldingRegisters, getRegisters, modbusCRC16,
};
