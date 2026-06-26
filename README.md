# Simulador Modbus RTU — C++ + Web

Sistema que demonstra a comunicação **Modbus RTU** entre um **mestre** e um
**escravo**, com botões interativos de **leitura (FC 0x03)** e **escrita (FC 0x06)**.

O núcleo do protocolo (montagem dos frames de bytes, CRC16, banco de
registradores do escravo) é escrito em **C++** e roda no navegador via
**WebAssembly**. A página é 100% estática — pode ser hospedada de graça.

```
modbus-web/
├── cpp/
│   └── modbus.cpp        ← núcleo Modbus em C++ (mestre/escravo, FC03/FC06, CRC16)
└── site/
    ├── index.html        ← interface (mestre, escravo, barramento, monitor)
    ├── style.css         ← tema de painel industrial
    ├── modbus-core.js    ← espelho da lógica C++ em JS (faz o site rodar na hora)
    └── app.js            ← liga a UI ao C++/WASM (ou ao espelho JS)
```

## Rodar AGORA (sem compilar nada)

O site já funciona usando o espelho em JavaScript, que produz **exatamente os
mesmos frames** do C++. Basta servir a pasta `site/`:

```bash
cd site
python3 -m http.server 8000
# abra http://localhost:8000
```

O rótulo no topo mostrará `motor: JavaScript (espelho do C++)`.

## Compilar o C++ para WebAssembly (motor C++ de verdade)

1. Instale o **Emscripten** (https://emscripten.org/docs/getting_started/downloads.html):

```bash
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk && ./emsdk install latest && ./emsdk activate latest
source ./emsdk_env.sh
```

2. Compile gerando `modbus.js` + `modbus.wasm` dentro de `site/`:

```bash
cd cpp
emcc modbus.cpp -O2 \
  -s MODULARIZE=1 -s EXPORT_NAME=createModbusModule \
  -s EXPORTED_RUNTIME_METHODS='["cwrap","UTF8ToString","HEAPU8"]' \
  -s EXPORTED_FUNCTIONS='["_writeSingleRegister","_readHoldingRegisters","_getRegister","_registerCount","_getFrameBuffer","_getFrameLength","_getExplainBuffer","_getAsciiBuffer","_setMode","_getMode"]' \
  -o ../site/modbus.js
```

3. Adicione no `index.html`, **antes** de `app.js`:

```html
<script src="modbus.js"></script>
```

Recarregue a página. O topo passará a mostrar `motor: C++ / WebAssembly ✓`.

## Testar o C++ no terminal (opcional)

```bash
cd cpp
g++ modbus.cpp -o modbus
./modbus
```

## Hospedar de graça

Como tudo é estático, basta subir a pasta `site/`:

- **GitHub Pages**: suba o repositório e ative Pages na branch (pasta `/site` ou raiz).
- **Netlify / Vercel**: arraste a pasta `site/` ou conecte o repositório.
- **Cloudflare Pages**: aponte para a pasta `site/`.

> Importante: arquivos `.wasm` precisam ser servidos com o MIME
> `application/wasm`. GitHub Pages, Netlify, Vercel e Cloudflare já fazem isso.

## Como funciona o protocolo (resumo)

Um quadro (frame) Modbus RTU tem o formato:

```
[ ID do escravo ][ código da função ][ dados... ][ CRC16 lo ][ CRC16 hi ]
```

- **FC 0x06 (escrever 1 registrador):** mestre envia `ID 06 ADDR_hi ADDR_lo VAL_hi VAL_lo CRC`.
  O escravo grava e devolve o mesmo frame como confirmação (eco).
- **FC 0x03 (ler registradores):** mestre pede `ID 03 ADDR qtd CRC`; o escravo
  responde `ID 03 nbytes DADOS... CRC`.
- **CRC16** (polinômio `0xA001`, init `0xFFFF`) detecta erros de transmissão.

O escravo deste projeto tem 16 holding registers (R0..R15), iniciando com
R0=100, R1=200, R2=300, R3=400.

## Modos de transmissão: RTU e ASCII

O botão **Modo** no topo alterna entre os dois modos padrão do Modbus:

- **RTU**: os bytes são transmitidos em binário cru; o checksum é o **CRC16**;
  não há caracteres delimitadores. Frame: `[ID][func][dados][CRC lo][CRC hi]`.
- **ASCII**: cada byte vira **2 caracteres hexadecimais** em texto; o frame
  começa com `:` (dois-pontos) e termina com `CR LF`; o checksum é o **LRC**
  (soma dos bytes em complemento de 2, 8 bits). Frame: `: hex hex ... LRC CR LF`.

Exemplo do mesmo comando (escrever 1234 no registrador 4) nos dois modos:

```
RTU   : 01 06 00 04 04 D2 4A 96            (CRC16 = 0x964A)
ASCII : :0106000404D21F<CR><LF>            (LRC = 0x1F)
```

Os dois carregam exatamente a mesma informação; mudam só a codificação na linha
e o tipo de verificação de erro. O modo é tratado no C++ (`setMode`, `buildAsciiFrame`,
`modbusLRC`).
