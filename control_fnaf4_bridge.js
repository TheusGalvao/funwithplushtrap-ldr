/**
 * ============================================================================
 * CONTROL_FNAF4 - EMULADOR & AUTO-RECEPTOR ESP PARA "FUN WITH PLUSHTRAP"
 * ============================================================================
 * - Conecta AUTOMATICAMENTE ao ESP/Arduino Mega via USB (115200 bps)
 *   assim que é iniciado.
 * - Monitora o sensor LDR em tempo real (mesmo com o navegador minimizado e o
 *   jogo "Fun with Plushtrap" em tela cheia).
 * - Enquanto pct >= 50%: mantém a tecla configurada (ex: CTRL) PRESSIONADA.
 * - Quando pct < 50%: SOLTA a tecla imediatamente.
 * ============================================================================
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 8765;
let LIMIAR_LUZ = 50;

// Estado Global do Sistema
let estadoSistema = {
  ldr: 0,
  max: 240,
  pct: 0,
  limiarLuz: 50,
  leds: 0,
  conectado: false,
  origem: 'Aguardando ESP via USB...',
  portaCom: null,
  segurandoTecla: false,
  emulacaoAtiva: true,
  modoWebSerialNavegador: false,
  tecla: {
    key: 'Control',
    code: 'ControlLeft',
    vk: 17,
    label: 'CTRL'
  }
};

// Processo persistente em C# (.NET nativo do Windows) para:
// 1. Emular teclado via user32.dll (keybd_event + ScanCodes de hardware p/ FNAF 4)
// 2. Ler e enviar comandos na porta Serial USB (115200 bps) automaticamente
const psScript = `
$code = @"
using System;
using System.IO.Ports;
using System.Runtime.InteropServices;
using System.Threading;

public class PlushtrapController {
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern uint MapVirtualKey(uint uCode, uint uMapType);

    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const byte VK_CONTROL = 0x11;
    public const byte VK_LCONTROL = 0xA2;

    private static SerialPort serial = null;
    private static bool pauseSerial = false;

    public static void KeyDown(byte vk) {
        byte scan = (byte)MapVirtualKey(vk, 0);
        keybd_event(vk, scan, 0, UIntPtr.Zero);
        if (vk == VK_CONTROL) {
            keybd_event(VK_LCONTROL, scan, 0, UIntPtr.Zero);
        }
    }

    public static void KeyUp(byte vk) {
        byte scan = (byte)MapVirtualKey(vk, 0);
        keybd_event(vk, scan, KEYEVENTF_KEYUP, UIntPtr.Zero);
        if (vk == VK_CONTROL) {
            keybd_event(VK_LCONTROL, scan, KEYEVENTF_KEYUP, UIntPtr.Zero);
        }
    }

    public static void StartSerialWatcher() {
        Thread t = new Thread(() => {
            while (true) {
                try {
                    if (pauseSerial) {
                        CloseSerial();
                        Thread.Sleep(1000);
                        continue;
                    }

                    if (serial == null || !serial.IsOpen) {
                        string[] ports = SerialPort.GetPortNames();
                        foreach (string p in ports) {
                            try {
                                SerialPort sp = new SerialPort(p, 115200);
                                sp.ReadTimeout = 500;
                                sp.WriteTimeout = 500;
                                sp.DtrEnable = false;
                                sp.RtsEnable = false;
                                sp.Open();
                                serial = sp;
                                Console.WriteLine("SERIAL_CONNECTED:" + p);
                                break;
                            } catch { }
                        }
                    }

                    if (serial != null && serial.IsOpen) {
                        try {
                            string line = serial.ReadLine();
                            if (!string.IsNullOrWhiteSpace(line)) {
                                Console.WriteLine("SERIAL_DATA:" + line.Trim());
                            }
                        } catch (TimeoutException) {
                        } catch {
                            CloseSerial();
                        }
                    } else {
                        Thread.Sleep(1200);
                    }
                } catch {
                    Thread.Sleep(1200);
                }
            }
        });
        t.IsBackground = true;
        t.Start();
    }

    public static void SendSerialCmd(string cmd) {
        try {
            if (serial != null && serial.IsOpen) {
                serial.WriteLine(cmd);
            }
        } catch { }
    }

    public static void SetPauseSerial(bool pause) {
        pauseSerial = pause;
        if (pause) CloseSerial();
    }

    public static void CloseSerial() {
        try {
            if (serial != null) {
                if (serial.IsOpen) serial.Close();
                serial.Dispose();
            }
        } catch { }
        if (serial != null) {
            serial = null;
            Console.WriteLine("SERIAL_DISCONNECTED");
        }
    }
}
"@
Add-Type -TypeDefinition $code
[PlushtrapController]::StartSerialWatcher()
Write-Output "READY"

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $trimmed = $line.Trim()
    if ($trimmed.StartsWith("DOWN ")) {
        $vk = [byte][int]($trimmed.Substring(5))
        [PlushtrapController]::KeyDown($vk)
    } elseif ($trimmed.StartsWith("UP ")) {
        $vk = [byte][int]($trimmed.Substring(3))
        [PlushtrapController]::KeyUp($vk)
    } elseif ($trimmed.StartsWith("CMD ")) {
        $cmd = $trimmed.Substring(4)
        [PlushtrapController]::SendSerialCmd($cmd)
    } elseif ($trimmed -eq "PAUSE_SERIAL") {
        [PlushtrapController]::SetPauseSerial($true)
    } elseif ($trimmed -eq "RESUME_SERIAL") {
        [PlushtrapController]::SetPauseSerial($false)
    }
}
`;

console.log('===================================================================');
console.log('  FNAF 4: "FUN WITH PLUSHTRAP" - CONTROLE LDR + ESP (AUTO-PRONTO)');
console.log('===================================================================');
console.log('Iniciando emulador de teclado e busca automática do ESP...');

const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
  stdio: ['pipe', 'pipe', 'pipe']
});

let teclaSeguradaVk = null;
let repeatInterval = null;
let stdoutBuffer = '';

ps.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk.toString();
  const lines = stdoutBuffer.split(/\r?\n/);
  stdoutBuffer = lines.pop();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line === 'READY') {
      console.log('[OK] Emulador nativo pronto! Aguardando sinal de iluminação (>= 50%)...');
    } else if (line.startsWith('SERIAL_CONNECTED:')) {
      const porta = line.substring('SERIAL_CONNECTED:'.length).trim();
      estadoSistema.conectado = true;
      estadoSistema.portaCom = porta;
      estadoSistema.origem = `USB Automático (${porta} @ 115200)`;
      console.log(`[CONECTADO] ESP/Arduino detectado automaticamente na porta ${porta}!`);
    } else if (line === 'SERIAL_DISCONNECTED') {
      if (!estadoSistema.modoWebSerialNavegador) {
        estadoSistema.conectado = false;
        estadoSistema.portaCom = null;
        estadoSistema.origem = 'Aguardando ESP via USB...';
        soltarTecla();
        console.log('[AVISO] Porta USB desconectada. Buscando reconexão...');
      }
    } else if (line.startsWith('SERIAL_DATA:')) {
      const payload = line.substring('SERIAL_DATA:'.length).trim();
      processarJsonEsp(payload, `USB (${estadoSistema.portaCom || 'COM'})`);
    }
  }
});

// Processa o JSON vindo do ESP via USB
function processarJsonEsp(textoJson, origemDescricao) {
  if (!textoJson.startsWith('{') || !textoJson.endsWith('}')) return;
  try {
    const d = JSON.parse(textoJson);
    if (d.ldr === undefined) return;

    const ldr = Number(d.ldr);
    const max = Number(d.max ?? 240);
    const pct = Number(d.pct ?? Math.min(100, Math.max(0, Math.round((ldr / max) * 100))));
    const leds = Number(d.leds ?? 0);

    estadoSistema.ldr = ldr;
    estadoSistema.max = max;
    estadoSistema.pct = pct;
    estadoSistema.leds = leds;
    estadoSistema.conectado = true;
    if (origemDescricao) estadoSistema.origem = origemDescricao;

    avaliarGatilhoLuz(pct);
  } catch (e) {}
}

// Avalia a regra: pct >= 50% segura a tecla | pct < 50% solta a tecla
function avaliarGatilhoLuz(pct) {
  if (!estadoSistema.emulacaoAtiva) {
    if (estadoSistema.segurandoTecla) soltarTecla();
    return;
  }

  if (pct >= LIMIAR_LUZ) {
    if (!estadoSistema.segurandoTecla) {
      pressionarSegurarTecla(estadoSistema.tecla.vk);
      console.log(`🔦 [LUZ ${pct}% >= ${LIMIAR_LUZ}%] LANTERNA ACESA! Segurando [${estadoSistema.tecla.label}] no Fun with Plushtrap`);
    }
  } else {
    if (estadoSistema.segurandoTecla) {
      soltarTecla();
      console.log(`🌑 [LUZ ${pct}% <  ${LIMIAR_LUZ}%] Lanterna apagada. Tecla [${estadoSistema.tecla.label}] solta`);
    }
  }
}

function pressionarSegurarTecla(vk) {
  if (teclaSeguradaVk && teclaSeguradaVk !== vk) {
    soltarTecla(teclaSeguradaVk);
  }
  teclaSeguradaVk = vk;
  estadoSistema.segurandoTecla = true;
  ps.stdin.write(`DOWN ${vk}\n`);

  // Reforço contínuo sem enviar KeyUp para manter a lanterna firme no Clickteam Fusion / DirectX
  if (repeatInterval) clearInterval(repeatInterval);
  repeatInterval = setInterval(() => {
    if (estadoSistema.segurandoTecla && teclaSeguradaVk === vk) {
      ps.stdin.write(`DOWN ${vk}\n`);
    }
  }, 55);
}

function soltarTecla(vk) {
  if (repeatInterval) {
    clearInterval(repeatInterval);
    repeatInterval = null;
  }
  const alvo = vk || teclaSeguradaVk || estadoSistema.tecla.vk;
  if (alvo) {
    ps.stdin.write(`UP ${alvo}\n`);
  }
  teclaSeguradaVk = null;
  estadoSistema.segurandoTecla = false;
}

// Servidor HTTP Local para comunicação em tempo real com control_fnaf4.html
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // 1. Retorno completo do estado atual para o HTML atualizar a tela automaticamente
  if (url.pathname === '/ping' || url.pathname === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ...estadoSistema }));
    return;
  }

  // 2. Mudança de tecla ou ativação/pausa vinda da interface HTML
  if (url.pathname === '/config') {
    const vk = parseInt(url.searchParams.get('vk') || '0', 10);
    const key = url.searchParams.get('key');
    const code = url.searchParams.get('code');
    const label = url.searchParams.get('label');
    const enabled = url.searchParams.get('enabled');
    const threshold = parseInt(url.searchParams.get('threshold') || '0', 10);
    const webserial = url.searchParams.get('webserial');

    if (threshold > 0 && threshold <= 100) {
      LIMIAR_LUZ = threshold;
      estadoSistema.limiarLuz = threshold;
      console.log(`[CONFIG] Limiar de ativação alterado para: ${threshold}%`);
      avaliarGatilhoLuz(estadoSistema.pct);
    }

    if (webserial !== null) {
      const usarNav = webserial === '1';
      estadoSistema.modoWebSerialNavegador = usarNav;
      ps.stdin.write(usarNav ? 'PAUSE_SERIAL\n' : 'RESUME_SERIAL\n');
    }

    if (enabled !== null) {
      estadoSistema.emulacaoAtiva = enabled === '1';
      if (!estadoSistema.emulacaoAtiva && estadoSistema.segurandoTecla) {
        soltarTecla();
      }
    }

    if (vk > 0) {
      if (estadoSistema.segurandoTecla) soltarTecla();
      estadoSistema.tecla = {
        key: key || 'Control',
        code: code || 'ControlLeft',
        vk,
        label: label || 'CTRL'
      };
      console.log(`[CONFIG] Tecla alterada para: ${estadoSistema.tecla.label} (VK: ${vk})`);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...estadoSistema }));
    return;
  }

  // 3. Envio de comandos de calibração (AUTO, UP, DOWN, LEFT, RIGHT, MAX:valor) ao ESP
  if (url.pathname === '/cmd') {
    const c = url.searchParams.get('c') || '';
    if (c) {
      if (estadoSistema.portaCom) {
        ps.stdin.write(`CMD ${c}\n`);
      }
      console.log(`[CALIBRAÇÃO] Comando enviado ao ESP via USB: ${c}`);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...estadoSistema }));
    return;
  }

  // 4. Acionamento direto caso o HTML esteja lendo via Web Serial do navegador
  if (url.pathname === '/key') {
    const action = url.searchParams.get('action');
    const vk = parseInt(url.searchParams.get('vk') || String(estadoSistema.tecla.vk), 10);

    if (action === 'down' && estadoSistema.emulacaoAtiva) {
      pressionarSegurarTecla(vk);
    } else if (action === 'up') {
      soltarTecla(vk);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, action, vk }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  const htmlPath = path.join(__dirname, 'control_fnaf4.html');
  console.log(`[OK] Servidor ativo em http://127.0.0.1:${PORT}`);
  console.log(`[OK] Interface Web: ${htmlPath}`);
  console.log('-------------------------------------------------------------------');
  console.log('PRONTO PARA JOGAR "FUN WITH PLUSHTRAP"!');
  console.log('Basta abrir o jogo e iluminar o LDR (>= 50%) para acionar a lanterna!');
  console.log('-------------------------------------------------------------------');
});

process.on('SIGINT', () => {
  if (estadoSistema.segurandoTecla) soltarTecla();
  ps.kill();
  process.exit(0);
});
