// =============================================================
//  modbus.cpp  -  Nucleo Modbus RTU simplificado em C++
//
//  Implementa:
//    - Um "escravo" (slave) com um banco de 16 holding registers
//    - Funcao 0x03 (Read Holding Registers)
//    - Funcao 0x06 (Write Single Register)
//    - Calculo de CRC16 (padrao Modbus)
//    - Montagem e interpretacao dos frames (quadros) de bytes
//
//  Compila para WebAssembly com Emscripten (ver README), e tambem
//  como executavel de terminal normal (g++ modbus.cpp -o modbus).
//
//  As funcoes marcadas com EMSCRIPTEN_KEEPALIVE sao chamadas
//  diretamente pelo JavaScript do site.
// =============================================================

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>
#include <string>

#ifdef __EMSCRIPTEN__
  #include <emscripten/emscripten.h>
#else
  #define EMSCRIPTEN_KEEPALIVE
#endif

// -------------------------------------------------------------
//  Estado do escravo: 16 holding registers (enderecos 0..15)
// -------------------------------------------------------------
static const int NUM_REGS = 16;
static uint16_t holdingRegisters[NUM_REGS] = {
    100, 200, 300, 400, 0, 0, 0, 0,
    0,   0,   0,   0,   0, 0, 0, 0
};

// Endereco deste escravo na rede Modbus (slave ID)
static const uint8_t SLAVE_ID = 1;

// Buffer onde guardamos o ultimo frame gerado, para o JS ler.
static uint8_t  frameBuffer[256];
static int      frameLength = 0;

// String com a explicacao legivel do ultimo frame, para o JS ler.
static char     explainBuffer[1024];

// Modo de transmissao: 0 = RTU (binario), 1 = ASCII (texto).
static int      transmissionMode = 0;

// Buffer com o frame no formato ASCII (string ":...<CR><LF>").
static char     asciiBuffer[600];

// -------------------------------------------------------------
//  CRC16 - padrao Modbus (polinomio 0xA001, init 0xFFFF)
// -------------------------------------------------------------
uint16_t modbusCRC16(const uint8_t* data, int len) {
    uint16_t crc = 0xFFFF;
    for (int i = 0; i < len; i++) {
        crc ^= (uint16_t)data[i];
        for (int bit = 0; bit < 8; bit++) {
            if (crc & 0x0001) {
                crc >>= 1;
                crc ^= 0xA001;
            } else {
                crc >>= 1;
            }
        }
    }
    return crc; // byte baixo primeiro ao transmitir (little-endian)
}

// Acrescenta o CRC ao fim de um frame (low byte, depois high byte).
static void appendCRC(uint8_t* frame, int& len) {
    uint16_t crc = modbusCRC16(frame, len);
    frame[len++] = (uint8_t)(crc & 0xFF);        // CRC low
    frame[len++] = (uint8_t)((crc >> 8) & 0xFF); // CRC high
}

// -------------------------------------------------------------
//  LRC - Longitudinal Redundancy Check (usado no modo ASCII)
//  E a soma de todos os bytes, negada em complemento de 2,
//  em 8 bits. Substitui o CRC16 quando o modo e ASCII.
// -------------------------------------------------------------
uint8_t modbusLRC(const uint8_t* data, int len) {
    uint8_t lrc = 0;
    for (int i = 0; i < len; i++) lrc += data[i];
    return (uint8_t)(-((int8_t)lrc)); // complemento de 2
}

// -------------------------------------------------------------
//  Converte os 'dataLen' bytes de dados (ID + funcao + dados,
//  SEM o CRC16) para um frame ASCII completo:
//     ':' + cada byte em 2 hex maiusculos + LRC + CR LF
//  O resultado vai para asciiBuffer.
// -------------------------------------------------------------
static void buildAsciiFrame(const uint8_t* data, int dataLen) {
    static const char* HEX = "0123456789ABCDEF";
    uint8_t lrc = modbusLRC(data, dataLen);
    int p = 0;
    asciiBuffer[p++] = ':';                       // inicio
    for (int i = 0; i < dataLen; i++) {           // dados em hex ASCII
        asciiBuffer[p++] = HEX[(data[i] >> 4) & 0xF];
        asciiBuffer[p++] = HEX[data[i] & 0xF];
    }
    asciiBuffer[p++] = HEX[(lrc >> 4) & 0xF];     // LRC em hex ASCII
    asciiBuffer[p++] = HEX[lrc & 0xF];
    asciiBuffer[p++] = '\r';                      // CR
    asciiBuffer[p++] = '\n';                      // LF
    asciiBuffer[p]   = '\0';
}

// -------------------------------------------------------------
//  Funcoes utilitarias expostas ao JavaScript
// -------------------------------------------------------------
extern "C" {

// Le um registrador (usado pela interface para mostrar o banco).
EMSCRIPTEN_KEEPALIVE
int getRegister(int addr) {
    if (addr < 0 || addr >= NUM_REGS) return -1;
    return holdingRegisters[addr];
}

EMSCRIPTEN_KEEPALIVE
int registerCount() { return NUM_REGS; }

// Ponteiros para o JS acessar os buffers de saida.
EMSCRIPTEN_KEEPALIVE uint8_t* getFrameBuffer()   { return frameBuffer; }
EMSCRIPTEN_KEEPALIVE int      getFrameLength()   { return frameLength; }
EMSCRIPTEN_KEEPALIVE char*    getExplainBuffer() { return explainBuffer; }

// Modo de transmissao: 0 = RTU, 1 = ASCII.
EMSCRIPTEN_KEEPALIVE void  setMode(int m) { transmissionMode = (m == 1) ? 1 : 0; }
EMSCRIPTEN_KEEPALIVE int   getMode()      { return transmissionMode; }
EMSCRIPTEN_KEEPALIVE char* getAsciiBuffer() { return asciiBuffer; }

// -------------------------------------------------------------
//  FC 0x06 - Write Single Register
//  O mestre escreve 'value' no registrador 'addr' do escravo.
//  Retorna 0 se OK, codigo de erro (>0) caso contrario.
// -------------------------------------------------------------
EMSCRIPTEN_KEEPALIVE
int writeSingleRegister(int addr, int value) {
    if (addr < 0 || addr >= NUM_REGS) return 2; // 2 = endereco invalido
    if (value < 0 || value > 0xFFFF)  return 3; // 3 = valor invalido

    // ---- Monta o frame de REQUISICAO (mestre -> escravo) ----
    uint8_t req[8];
    int n = 0;
    req[n++] = SLAVE_ID;                 // endereco do escravo
    req[n++] = 0x06;                     // codigo da funcao
    req[n++] = (uint8_t)(addr >> 8);     // endereco do registrador (high)
    req[n++] = (uint8_t)(addr & 0xFF);   // endereco do registrador (low)
    req[n++] = (uint8_t)(value >> 8);    // valor (high)
    req[n++] = (uint8_t)(value & 0xFF);  // valor (low)
    appendCRC(req, n);                   // 2 bytes de CRC

    // ---- O escravo processa: grava o valor ----
    holdingRegisters[addr] = (uint16_t)value;

    // ---- A RESPOSTA do FC06 e um eco da requisicao ----
    memcpy(frameBuffer, req, n);
    frameLength = n;

    // ---- Versao ASCII do mesmo frame (dados = n-2, sem o CRC16) ----
    buildAsciiFrame(req, n - 2);

    // ---- Explicacao legivel ----
    snprintf(explainBuffer, sizeof(explainBuffer),
        "FUNCAO 0x06 - Escrever Registrador Unico\n"
        "Escravo ID: %d  |  Registrador: %d  |  Valor: %d\n"
        "CRC16: 0x%04X\n"
        "O escravo gravou o valor e devolveu o mesmo frame como confirmacao.",
        SLAVE_ID, addr, value, modbusCRC16(req, n - 2));
    return 0;
}

// -------------------------------------------------------------
//  FC 0x03 - Read Holding Registers
//  O mestre le 'count' registradores a partir de 'addr'.
//  Monta a resposta do escravo no frameBuffer.
//  Retorna 0 se OK, codigo de erro (>0) caso contrario.
// -------------------------------------------------------------
EMSCRIPTEN_KEEPALIVE
int readHoldingRegisters(int addr, int count) {
    if (count < 1 || count > NUM_REGS)          return 3;
    if (addr < 0 || addr + count > NUM_REGS)    return 2;

    // ---- RESPOSTA do escravo (escravo -> mestre) ----
    uint8_t resp[256];
    int n = 0;
    resp[n++] = SLAVE_ID;                 // endereco do escravo
    resp[n++] = 0x03;                     // codigo da funcao
    resp[n++] = (uint8_t)(count * 2);     // numero de bytes de dados
    for (int i = 0; i < count; i++) {
        uint16_t v = holdingRegisters[addr + i];
        resp[n++] = (uint8_t)(v >> 8);    // dado (high)
        resp[n++] = (uint8_t)(v & 0xFF);  // dado (low)
    }
    appendCRC(resp, n);

    memcpy(frameBuffer, resp, n);
    frameLength = n;

    // ---- Versao ASCII do mesmo frame (dados = n-2, sem o CRC16) ----
    buildAsciiFrame(resp, n - 2);

    // ---- Explicacao legivel ----
    int off = snprintf(explainBuffer, sizeof(explainBuffer),
        "FUNCAO 0x03 - Ler Registradores\n"
        "Escravo ID: %d  |  Inicio: %d  |  Quantidade: %d\n"
        "Valores lidos: ",
        SLAVE_ID, addr, count);
    for (int i = 0; i < count && off < (int)sizeof(explainBuffer) - 16; i++) {
        off += snprintf(explainBuffer + off, sizeof(explainBuffer) - off,
                        "%d ", holdingRegisters[addr + i]);
    }
    snprintf(explainBuffer + off, sizeof(explainBuffer) - off,
             "\nCRC16: 0x%04X", modbusCRC16(resp, n - 2));
    return 0;
}

} // extern "C"

// -------------------------------------------------------------
//  main() - so roda quando compilado para terminal (teste local).
//  No WebAssembly o site chama as funcoes diretamente.
// -------------------------------------------------------------
#ifndef __EMSCRIPTEN__
static void dumpFrame(const char* titulo) {
    printf("%s\n", titulo);
    printf("  Frame (%d bytes): ", frameLength);
    for (int i = 0; i < frameLength; i++) printf("%02X ", frameBuffer[i]);
    printf("\n  %s\n\n", explainBuffer);
}

int main() {
    printf("=== Demo Modbus RTU em C++ ===\n\n");

    writeSingleRegister(4, 1234);
    dumpFrame("[Mestre] Escreve 1234 no registrador 4 (FC06):");

    readHoldingRegisters(0, 6);
    dumpFrame("[Mestre] Le 6 registradores a partir do 0 (FC03):");

    return 0;
}
#endif
