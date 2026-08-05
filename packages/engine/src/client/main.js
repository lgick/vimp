import './style.css';
import 'pixi.js/unsafe-eval';
import { Application, Ticker } from 'pixi.js';
import InputListener from './InputListener.js';
import AuthModel from './components/model/Auth.js';
import AuthView from './components/view/Auth.js';
import AuthCtrl from './components/controller/Auth.js';
import CanvasManagerModel from './components/model/CanvasManager.js';
import CanvasManagerView from './components/view/CanvasManager.js';
import CanvasManagerCtrl from './components/controller/CanvasManager.js';
import ControlsModel from './components/model/Controls.js';
import ControlsView from './components/view/Controls.js';
import ControlsCtrl from './components/controller/Controls.js';
import GameModel from './components/model/Game.js';
import GameView from './components/view/Game.js';
import GameCtrl from './components/controller/Game.js';
import ChatModel from './components/model/Chat.js';
import ChatView from './components/view/Chat.js';
import ChatCtrl from './components/controller/Chat.js';
import PanelModel from './components/model/Panel.js';
import PanelView from './components/view/Panel.js';
import PanelCtrl from './components/controller/Panel.js';
import StatModel from './components/model/Stat.js';
import StatView from './components/view/Stat.js';
import StatCtrl from './components/controller/Stat.js';
import VoteModel from './components/model/Vote.js';
import VoteView from './components/view/Vote.js';
import VoteCtrl from './components/controller/Vote.js';
import {
  buildForm,
  mergeRoomDefaults,
  reportFormValidity,
} from './lib/formBuilder.js';
import { getHostGateState } from './lib/hostGate.js';
import { createDebugApi, debugLog, DEBUG_PREFIX } from './debug.js';
import { buildClientCoreConfig } from '../lib/clientCoreConfig.js';
import {
  buildSnapshotKeysById,
  reconstructHot,
} from '../lib/reconstructHot.js';
import Factory from '../lib/factory.js';
import { formatMessage } from '../lib/formatters.js';
import { sanitizeMessage } from '../lib/sanitizers.js';
import { validateAuth } from '../lib/validators.js';
import SoundManager from './SoundManager.js';
import SignalingClient from './network/SignalingClient.js';
import WebRtcManager from './network/WebRtcManager.js';
import HostController from './network/HostController.js';
import HostConnectionManager from './network/HostConnectionManager.js';
import LoopbackTransport from './network/LoopbackTransport.js';
import { supportsModuleWorker } from './network/workerSupport.js';
import LobbyModel from './components/model/Lobby.js';
import LobbyView from './components/view/Lobby.js';
import LobbyCtrl from './components/controller/Lobby.js';
import LobbyAuthModel from './components/model/LobbyAuth.js';
import LobbyAuthView from './components/view/LobbyAuth.js';
import LobbyAuthCtrl from './components/controller/LobbyAuth.js';
import BakingProvider from './providers/BakingProvider.js';
import DependencyProvider from './providers/DependencyProvider.js';
import { HOT_FLAGS } from '../config/opcodes.js';
import wsports from '../config/wsports.js';
import GAME_CODES from '../config/gameCodes.js';
import {
  fetchGamesManifest,
  fetchGameManifest as fetchGamePluginManifest,
  loadClientPlugin,
} from '../lib/gamePlugin.js';
import lobbyConfig from '../config/lobby.js';
import authClientConfig from '../config/authClient.js';
import clientDefaults from '../config/clientDefaults.js';

// Динамическая загрузка игры по каталогу мастера (Этап 6.3): активная для
// host остаётся первой записью каталога (граница lobby-page-plan — динамика
// загрузки ClientPlugin выбранной игры откладывается до появления второй
// игры), но сам каталог манифестов (gamesManifest) теперь используется
// целиком — селектором игр и Leaderboard (populateGameSelect/gamesById в
// initLobby). ClientPlugin (parts, bakers, игровой CSS, хуки ядра) грузится
// по entries.client её манифеста — движок больше не импортирует игру статически
let activeGameManifest;
let clientPlugin;
let parts;
let gamesManifest;

try {
  gamesManifest = await fetchGamesManifest(lobbyConfig.gamesManifestUrl);

  activeGameManifest = gamesManifest[0];

  if (!activeGameManifest) {
    throw new Error('master has no games in its catalog');
  }

  clientPlugin = await loadClientPlugin(activeGameManifest);
  parts = clientPlugin.parts;

  const gameStyle = document.createElement('style');
  gameStyle.textContent = clientPlugin.styles;
  document.head.append(gameStyle);
} catch (e) {
  document.body.textContent = `Failed to load the game: ${e.message}`;
  throw e;
}

// PS (server ports): порты получения данные от сервера
const PS_CONFIG_DATA = wsports.server.CONFIG_DATA;
const PS_AUTH_DATA = wsports.server.AUTH_DATA;
const PS_AUTH_RESULT = wsports.server.AUTH_RESULT;
const PS_MAP_DATA = wsports.server.MAP_DATA;
const PS_FIRST_SHOT_DATA = wsports.server.FIRST_SHOT_DATA;
const PS_SOUND_DATA = wsports.server.SOUND_DATA;
const PS_GAME_INFORM_DATA = wsports.server.GAME_INFORM_DATA;
const PS_TECH_INFORM_DATA = wsports.server.TECH_INFORM_DATA;
const PS_MISC = wsports.server.MISC;
const PS_PING = wsports.server.PING;
const PS_CLEAR = wsports.server.CLEAR;
const PS_CONSOLE = wsports.server.CONSOLE;
const PS_PANEL_DATA = wsports.server.PANEL_DATA;
const PS_STAT_DATA = wsports.server.STAT_DATA;
const PS_CHAT_DATA = wsports.server.CHAT_DATA;
const PS_VOTE_DATA = wsports.server.VOTE_DATA;
const PS_KEYSET_DATA = wsports.server.KEYSET_DATA;

// PC (client ports): порты получения данных от клиента
const PC_CONFIG_READY = wsports.client.CONFIG_READY;
const PC_AUTH_RESPONSE = wsports.client.AUTH_RESPONSE;
const PC_MODULES_READY = wsports.client.MODULES_READY;
const PC_MAP_READY = wsports.client.MAP_READY;
const PC_FIRST_SHOT_READY = wsports.client.FIRST_SHOT_READY;
const PC_KEYS_DATA = wsports.client.KEYS_DATA;
const PC_CHAT_DATA = wsports.client.CHAT_DATA;
const PC_VOTE_DATA = wsports.client.VOTE_DATA;
const PC_PONG = wsports.client.PONG;

// сигнальный WebSocket мастера (лобби + установка P2P); игровой трафик идёт
// по WebRTC (transport), не через мастер
const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const signaling = new SignalingClient(`${wsProtocol}//${location.host}/`);

// активное P2P-соединение с хостом (создаётся при выборе сервера в лобби)
let transport = null;

// hostId комнаты, к которой подключён гость (для /like·/unlike напрямую
// мастеру). У хоста-игрока (своя вкладка) остаётся null — за себя не проголосовать
let currentHostId = null;

const modules = {};

// создание и инициализация SoundManager
const soundManager = new SoundManager();
let soundData = {};

const inputListener = new InputListener();

let modulesConfig = {};
let initIdList = [];
const apps = {};

let gameInformer = null;
let gameInformList = []; // массив игровых сообщений
let panelView = null;

const techInformer = document.getElementById('tech-informer');

// массив системных сообщений: дефолт — из бандла, актуализируется CONFIG_DATA
// хоста. Дефолт обязателен: отказ полной комнаты (roomFull) приходит ДО
// CONFIG_DATA — без него клиент показал бы «Unknown error»
let techInformList = clientDefaults.techInformList;

// код 'loading' — единственный не-терминальный tech-код (см. TECH_CODES)
const TECH_LOADING_CODE = 2;
// код начала раунда (общий контракт с хостом — см. GAME_CODES)
const GAME_ROUND_START_CODE = GAME_CODES.roundStart[0];
// показан ли терминальный tech-код (кик, полная комната): причина закрытия
// соединения важнее общего сообщения handleDisconnect
let terminalInformShown = false;
// снятие предыдущего animationend-листенера логотипа при повторном
// playLogoRoundStart — иначе листенеры копятся при частых стартах раунда
let logoAnimationEndHandler = null;

const CTRL = {}; // контроллеры
let gameSets = {}; // наборы конструкторов (id: [наборы])
let entitiesOnCanvas = {}; // сущности, отображаемые на полотнах
let currentMapSetId; // текущий id набора конструкторов для карт
const socketMethods = []; // методы для обработки сокет-данных

// клиентское ядро (WASM, срез 2.6): интерполяция снапшотов, предикт своего
// танка, визуальный спавн выстрелов и распаковка кадров v3 — создаётся при
// получении конфига; wasm — результат init() для zero-copy чтения памяти
let clientCore = null;
let wasm = null;
let inputSeq = 0; // номер отправленного ввода (KEYS_DATA)

// обратный индекс снапшот-схемы игры (CONFIG_DATA.snapshot):
// keyId → { key, kind, width } — раскладку hot-буфера диктует схема,
// движковый бандл её не знает
let snapshotKeysById = null;

// SOCKET МЕТОДЫ

// config data
socketMethods[PS_CONFIG_DATA] = async data => {
  gameSets = data.parts.gameSets;
  entitiesOnCanvas = data.parts.entitiesOnCanvas;

  // ширина hot-записи: keyId + id + поля класса по схеме игры
  snapshotKeysById = buildSnapshotKeysById(data.snapshot);

  // клиентское ядро: интерполяция + предикт + спавн выстрелов; конфиг
  // собирается из interpolation/prediction CONFIG_DATA (хост шлёт их
  // через buildClientConfig в Worker'е). wasmUrl — общий с host-плагином
  // ассет из манифеста активной игры (entries.wasm)
  const { core, memory } = await clientPlugin.createClientCore(
    JSON.stringify(buildClientCoreConfig(data)),
    { wasmUrl: activeGameManifest.entries.wasm },
  );

  clientCore = core;
  wasm = { memory };

  // инициализация сущностей игры
  for (const entity of Object.keys(entitiesOnCanvas)) {
    Factory.add({ [entity]: parts[entity] });
  }

  gameInformer = document.getElementById(data.gameInform.id);
  gameInformList = data.gameInform.list;

  techInformList = data.techInformList;

  modulesConfig = data.modules;
  initIdList = data.initIdList;

  const bakedAssets = data.parts.bakedAssets || {};
  const componentDependencies = data.parts.componentDependencies || {};

  // путь к звукам — из assetsBase манифеста активной игры (Этап 6.3), не из
  // бандла движка: сборка игры кладёт свою копию звуков рядом с
  // client/host-бандлами (dist/sounds в пакете игры, например @vimp-games/tanks)
  soundData = {
    ...(data.parts.sounds || {}),
    path: `${activeGameManifest.assetsBase}sounds/`,
  };

  // создание полотен игры: canvas-элементы генерируются из конфига
  // канвасов игры (в HTML их нет)
  const canvasesConfig = modulesConfig.canvasManager.canvases;

  const initPromises = Object.keys(canvasesConfig).map(async canvasId => {
    const canvas =
      document.getElementById(canvasId) ?? document.createElement('canvas');

    if (!canvas.parentNode) {
      canvas.setAttribute('id', canvasId);
      canvas.width = canvasesConfig[canvasId].width;
      canvas.height = canvasesConfig[canvasId].height;
      document.body.appendChild(canvas);
    }

    const app = new Application();
    const assetProvider = new BakingProvider(clientPlugin.bakers);
    const dependencyProvider = new DependencyProvider();
    const bakingArr = bakedAssets[canvasId];

    await app.init({
      canvas,
      width: canvas.width,
      height: canvas.height,
      antialias: true,
      backgroundAlpha: 0,
      sharedTicker: true,
      accessibilityOptions: {
        activateOnTab: false,
      },
    });

    // пул всех доступных сервисов в этом контексте
    const availableServices = {
      renderer: app.renderer,
      soundManager,
    };

    // если есть данные для запекания компонентов
    if (bakingArr) {
      assetProvider.bakeAll(bakingArr, app);
    }

    dependencyProvider.collectAll(availableServices, componentDependencies);

    CTRL[canvasId] = makeGameController(
      assetProvider.getAssetsCollection(),
      dependencyProvider.getDependenciesCollection(),
      app,
    );

    apps[canvasId] = app;
  });

  Promise.all(initPromises)
    .then(() => {
      sending(PC_CONFIG_READY); // config ready
    })

    .catch(err => {
      console.error('Initialization error:', err);
    });
};

// auth data
socketMethods[PS_AUTH_DATA] = data => {
  if (typeof data !== 'object' || data === null) {
    return;
  }

  const { elems, params, texts } = data;

  document.getElementById('logo').textContent = texts?.title || 'VIMP';

  params.forEach(param => {
    const { storage } = param.options;

    if (storage) {
      param.value = localStorage[storage] || param.value || '';
    }
  });

  // клиент проверяет только движковые правила (isValidName): игровые
  // валидаторы (isValidModel) не идут по проводу и не грузятся с
  // ClientPlugin (HostPlugin.authSchema — только у хоста). Хост валидирует
  // их авторитетно (host.worker.js) — рассинхрон вернётся в AUTH_RESULT
  const clientValidator = authData => validateAuth(authData, params);

  const authModel = new AuthModel(clientValidator);
  const authView = new AuthView(authModel, elems, texts, params);
  modules.auth = new AuthCtrl(authModel, authView);

  authModel.publisher.on('socket', data => {
    // игровой хук авторизации (модель танка для реплик движения и выстрелов)
    if (clientCore) {
      clientPlugin.hooks.onAuth(clientCore, data);
    }

    // ник больше не вводится в игровой форме — токен лобби несёт claim
    // 'nick', хост проверяет его подпись по /jwks и берёт ник оттуда (Этап B3)
    sending(PC_AUTH_RESPONSE, { ...data, token: lobbyAuthModel.getToken() });
  });

  modules.auth.init(params);
};

// auth errors
socketMethods[PS_AUTH_RESULT] = async err => {
  modules.auth.parseRes(err);

  if (!err) {
    await soundManager.init(soundData);
    runModules(modulesConfig);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    for (const id of initIdList) {
      const elem = document.getElementById(id);

      if (elem) {
        elem.style.display = id === 'panel' ? 'flex' : 'block';
      }
    }

    sending(PC_MODULES_READY);
  }
};

// map data
socketMethods[PS_MAP_DATA] = data => {
  const { scale, layers, map, step, setId, spriteSheet, physicsStatic } = data;

  // ядру — мир для raycast выстрелов (+сброс буфера кадров и предикта)
  try {
    clientCore?.set_map(
      JSON.stringify({
        map,
        step,
        scale,
        physicsStatic,
        physicsDynamic: data.physicsDynamic,
      }),
    );
  } catch (e) {
    console.warn('[clientCore] set_map failed:', e);
  }

  // удаление данных карт
  const removeMap = setId => {
    const nameArr = gameSets[setId] || [];

    nameArr.forEach(name => {
      CTRL[entitiesOnCanvas[name]].remove(name);
    });
  };

  // создание карт
  const createMap = (setId, staticData) => {
    const nameArr = gameSets[setId];
    const dynamicArr = data.physicsDynamic || [];
    const dynamicData = {};

    dynamicArr.forEach((item, index) => {
      const key = `d${index}`;
      dynamicData[key] = { ...item, type: 'dynamic', scale };
    });

    nameArr.forEach(name => {
      const canvasId = entitiesOnCanvas[name];

      // статические данные карты
      CTRL[canvasId].parse(name, staticData);

      // динамические данные карты
      CTRL[canvasId].parse(name, dynamicData);
    });

    currentMapSetId = setId;
  };

  const staticData = Object.entries(layers).reduce(
    (acc, [layer, tiles], index) => {
      acc[`s${index}`] = {
        type: 'static',
        spriteSheet,
        map,
        step,
        layer,
        tiles,
        physicsStatic,
        scale,
      };

      return acc;
    },
    {},
  );

  removeMap(currentMapSetId);
  createMap(setId, staticData);
  sending(PC_MAP_READY);
};

// первый shot сразу после загрузки карты (JSON; порт 5 идёт бинарным путём);
// применяется немедленно (создание сущностей), в буфер интерполяции не пушится
socketMethods[PS_FIRST_SHOT_DATA] = data => {
  const [game, camera] = data;

  applyShot(game, camera);

  // подтверждение получения первого шота
  sending(PC_FIRST_SHOT_READY);
};

// panel data
socketMethods[PS_PANEL_DATA] = data => {
  modules.panel.update(data);

  // игровой хук: зеркало панели в клиентском ядре (гейты try_fire)
  if (clientCore) {
    clientPlugin.hooks.onPanel(clientCore, data);
  }
};

// stat data
socketMethods[PS_STAT_DATA] = data => {
  modules.stat.update(data);
};

// chat data
socketMethods[PS_CHAT_DATA] = data => {
  modules.chat.add(data);
};

// vote data
socketMethods[PS_VOTE_DATA] = data => {
  modules.vote.open(data);
};

// keyset data (смена режима спектатор/игрок)
socketMethods[PS_KEYSET_DATA] = keySet => {
  modules.controls.changeKeySet(keySet);
  clientCore?.set_active(keySet === 1);
};

// sound data
socketMethods[PS_SOUND_DATA] = sample => {
  soundManager.playSystemSound(sample);
};

// game inform data
socketMethods[PS_GAME_INFORM_DATA] = data => {
  if (data) {
    const [key, arr] = data;

    gameInformer.textContent = formatMessage(gameInformList[key], arr);
    gameInformer.style.display = 'block';

    setTimeout(() => {
      gameInformer.textContent = '';
      gameInformer.style.display = 'none';
    }, 3000);

    if (key === GAME_ROUND_START_CODE) {
      playLogoRoundStart();
      panelView?.playRoundStart();
    }
  }
};

// проигрывает shimmer-волну по логотипу в начале раунда; логотип живёт вне
// PanelView.containerId, поэтому панель им не управляет (см. docs/en/client.md)
const playLogoRoundStart = () => {
  const logo = document.getElementById('logo');

  if (!logo) {
    return;
  }

  if (logoAnimationEndHandler) {
    logo.removeEventListener('animationend', logoAnimationEndHandler);
  }

  logo.classList.remove('logo-round-start');
  void logo.offsetWidth; // reflow: перезапуск анимации при повторном добавлении класса
  logo.classList.add('logo-round-start');

  logoAnimationEndHandler = () => {
    logo.classList.remove('logo-round-start');
    logoAnimationEndHandler = null;
  };

  logo.addEventListener('animationend', logoAnimationEndHandler, {
    once: true,
  });
};

// technical inform data
socketMethods[PS_TECH_INFORM_DATA] = data => {
  if (data) {
    let message;

    if (Array.isArray(data)) {
      const [key, arr] = data;

      message = formatMessage(techInformList[key], arr) || 'Unknown error';
      // терминальные коды (кик, полная комната) — причина закрытия соединения,
      // последующий handleDisconnect не должен затирать её общим сообщением
      terminalInformShown = key !== TECH_LOADING_CODE;
    } else {
      message = data;
    }

    modules.controls?.disableKeys();
    techInformer.textContent = message;
    techInformer.style.display = 'block';
  } else {
    modules.controls?.enableKeys();
    terminalInformShown = false;
    techInformer.textContent = '';
    techInformer.style.display = 'none';
  }
};

// misc
socketMethods[PS_MISC] = data => {
  const { key, value } = data;

  if (key === 'localstorageNameReplace') {
    localStorage['userName'] = value;
  }
};

// ping
socketMethods[PS_PING] = pingId => {
  sending(PC_PONG, pingId, false);
};

// clear
socketMethods[PS_CLEAR] = function (setIdList) {
  // если есть список setId (учитывается в том числе пустой список)
  if (Array.isArray(setIdList)) {
    for (let i = 0, len = setIdList.length; i < len; i += 1) {
      const nameArr = gameSets[setIdList[i]] || [];

      nameArr.forEach(name => {
        CTRL[entitiesOnCanvas[name]].remove(name);
      });
    }
  } else {
    for (const p in CTRL) {
      if (Object.hasOwn(CTRL, p)) {
        CTRL[p].remove();
      }
    }
  }

  clientCore?.reset();
  soundManager.reset();
};

// console: логи авторитетной половины (Worker изолирован от DevTools вкладки —
// иначе его события в браузере не видны вовсе, этап 6 плана plan/done/ai-debug)
socketMethods[PS_CONSOLE] = data => {
  console.log(`${DEBUG_PREFIX}[host]`, data);
};

// ФУНКЦИИ

// применяет игровые данные к сущностям
function applyGameData(game) {
  Object.entries(game).forEach(([p, instances]) => {
    const nameArr = gameSets[p];

    nameArr.forEach(name => {
      CTRL[entitiesOnCanvas[name]].parse(name, instances);
    });
  });
}

// применяет данные камеры (позиция слушателя звука + полотно)
function applyCamera(camera) {
  if (camera && camera !== 0) {
    soundManager.setListenerPosition(camera[0], camera[1]);
    modules.canvasManager.updateCoords(camera);
  }
}

// применяет кадр целиком (первый кадр и дискретные кадры интерполяции)
function applyShot(game, camera) {
  applyGameData(game);
  applyCamera(camera);
}

// рендер-тик: ядро выдаёт пересечённые кадры (события, создания/удаления)
// JSON-очередью, а горячие позиции (танки/динамика/камера + предсказанный
// свой танк) — плоским Float32-буфером zero-copy из памяти WASM
function renderTick() {
  if (!clientCore) {
    return;
  }

  const len = clientCore.sample(performance.now());

  // view пересоздаётся каждый тик: рост памяти WASM детачит buffer
  const hot = new Float32Array(wasm.memory.buffer, clientCore.hot_ptr(), len);
  const flags = hot[0];

  if (flags & HOT_FLAGS.FRAMES) {
    JSON.parse(clientCore.take_frames()).forEach(frame => {
      applyShot(frame.game, frame.camera);
    });
  }

  if (flags & (HOT_FLAGS.GAME | HOT_FLAGS.PREDICTED)) {
    applyGameData(reconstructHot(hot, snapshotKeysById));
  }

  if (flags & HOT_FLAGS.CAMERA) {
    // камера уже разрешена ядром: предсказанная позиция либо интерполированная
    applyCamera([hot[1], hot[2]]);
  }

  soundManager.processAudibility();
  soundManager.updateActiveSounds();
}

// создает пользователя
function runModules(data) {
  const {
    canvasManager: canvasManagerData,
    controls: controlsData,
    chat: chatData,
    panel: panelData,
    stat: statData,
    vote: voteData,
  } = data;

  //==========================================//
  // CanvasManager Module
  //==========================================//

  const canvasManagerModel = new CanvasManagerModel(canvasManagerData);

  const canvasManagerView = new CanvasManagerView(canvasManagerModel, apps);

  modules.canvasManager = new CanvasManagerCtrl(
    canvasManagerModel,
    canvasManagerView,
  );
  modules.canvasManager.resize({
    width: innerWidth,
    height: innerHeight,
  });

  //==========================================//
  // Controls Module
  //==========================================//

  const controlsModel = new ControlsModel(controlsData);
  const controlsView = new ControlsView(controlsModel);

  modules.controls = new ControlsCtrl(controlsModel, controlsView);
  modules.controls.resetCursorHideTimer();

  //==========================================//
  // Chat Module
  //==========================================//

  const chatModel = new ChatModel({
    listLimit: chatData.params.listLimit,
    lineTime: chatData.params.lineTime,
    cacheMin: chatData.params.cacheMin,
    cacheMax: chatData.params.cacheMax,
    messages: chatData.params.messages,
    sanitizeMessage,
    formatMessage,
  });

  const chatView = new ChatView(chatModel, chatData.elems);

  modules.chat = new ChatCtrl(chatModel, chatView);

  //==========================================//
  // Panel Module
  //==========================================//

  const panelModel = new PanelModel(panelData.keys, panelData.fields);

  // PanelView генерирует DOM по типам схемы игры ({ containerId, fields })
  panelView = new PanelView(panelModel, panelData);

  modules.panel = new PanelCtrl(panelModel, panelView);

  //==========================================//
  // Stat Module
  //==========================================//

  const statModel = new StatModel(statData.params);

  // StatView генерирует шапку и таблицы по схеме игры ({ elems, params })
  const statView = new StatView(statModel, statData);

  modules.stat = new StatCtrl(statModel, statView);

  //==========================================//
  // Vote Module
  //==========================================//

  const voteModel = new VoteModel({ ...voteData.params, formatMessage });
  const voteView = new VoteView(voteModel, voteData.elems);

  modules.vote = new VoteCtrl(voteModel, voteView);

  //==========================================//
  // Подписка на события
  //==========================================//

  // событие активации режима
  controlsModel.publisher.on('mode', openMode);

  // подписка на данные от пользователя для режимов
  controlsModel.publisher.on('chat', modules.chat.updateCmd.bind(modules.chat));
  controlsModel.publisher.on('stat', modules.stat.close.bind(modules.stat));
  controlsModel.publisher.on('vote', modules.vote.assignKey.bind(modules.vote));

  inputListener.publisher.on(
    'keyDown',
    modules.controls.add.bind(modules.controls),
  );
  inputListener.publisher.on(
    'keyUp',
    modules.controls.remove.bind(modules.controls),
  );
  inputListener.publisher.on(
    'mouseAction',
    modules.controls.resetCursorHideTimer.bind(modules.controls),
  );
  inputListener.publisher.on(
    'resize',
    modules.canvasManager.resize.bind(modules.canvasManager),
  );

  chatModel.publisher.on(
    'mode',
    modules.controls.switchMode.bind(modules.controls),
  );
  statModel.publisher.on(
    'mode',
    modules.controls.switchMode.bind(modules.controls),
  );
  voteModel.publisher.on(
    'mode',
    modules.controls.switchMode.bind(modules.controls),
  );

  controlsModel.publisher.on('socket', data => {
    // формат wire: 'seq:action:name' (seq — подтверждение ввода сервером)
    const [action, name] = data.split(':');
    const now = performance.now();

    inputSeq = (inputSeq + 1) >>> 0;
    clientCore?.apply_input(action, name, now);

    // игровой хук: визуальный спавн своего выстрела и локальная смена
    // оружия (try_fire/cycle_weapon; гейты в ядре)
    if (clientCore) {
      const spawn = clientPlugin.hooks.onLocalAction(
        clientCore,
        action,
        name,
        now,
      );

      if (spawn) {
        applyGameData(JSON.parse(spawn));
      }
    }

    sending(PC_KEYS_DATA, `${inputSeq}:${data}`);
  });
  chatModel.publisher.on('socket', handleChatSend);
  voteModel.publisher.on('socket', data => sending(PC_VOTE_DATA, data));

  //==========================================//
  // Рендер-цикл интерполяции
  //==========================================//

  Ticker.shared.add(renderTick);
}

// создает экземпляр игры
function makeGameController(assetsCollection, dependenciesCollection, app) {
  const model = new GameModel(assetsCollection, dependenciesCollection);
  const view = new GameView(model, app);
  const controller = new GameCtrl(model, view);

  return controller;
}

// открывает режим
function openMode(mode) {
  if (modules[mode]) {
    modules[mode].open();
  }
}

// отправляет данные хосту (весь клиентский протокол — по надёжному каналу meta)
// reliable=false — по ненадёжному state-каналу (только pong: замер RTT
// должен отражать сетевой путь, а не reliable-поток с ретрансмиссиями)
function sending(name, data, reliable = true) {
  transport?.send(JSON.stringify([name, data]), reliable);
}

// перехватывает /like·/unlike <причина> и шлёт голос напрямую мастеру по
// сигнальному WS, минуя хоста: его CommandProcessor мог бы отфильтровать
// голос против самого себя (server-rating этап 2, замена /ban). Причина
// обязательна (публично не отображается). Остальной чат уходит хосту
function handleChatSend(message) {
  const likeMatch = message === '/like' || message.startsWith('/like ');
  const unlikeMatch = message === '/unlike' || message.startsWith('/unlike ');

  if (likeMatch || unlikeMatch) {
    const command = likeMatch ? '/like' : '/unlike';
    const reason = message.slice(command.length).trim();
    const token = lobbyAuthModel.getToken();

    if (!currentHostId) {
      modules.chat.add([`${command} is available to room guests only`]);
    } else if (!token) {
      modules.chat.add([`${command} requires signing in`]);
    } else if (!reason) {
      modules.chat.add([`${command} requires a reason: ${command} <reason>`]);
    } else if (!signaling.connected) {
      modules.chat.add(['No connection to the master server — vote not sent']);
    } else if (likeMatch) {
      signaling.likeHost(currentHostId, reason, token);
      modules.chat.add(['Vote sent to the master server']);
    } else {
      signaling.unlikeHost(currentHostId, reason, token);
      modules.chat.add(['Vote sent to the master server']);
    }

    return;
  }

  sending(PC_CHAT_DATA, message);
}

// распаковывает данные
function unpacking(pack) {
  return JSON.parse(pack);
}

// обработчик видимости вкладки
function handleVisibilityChange() {
  // если вкладка неактивна, выключение звука
  if (document.visibilityState === 'hidden') {
    soundManager.mute();
    // иначе включение звука при возвращении
  } else {
    soundManager.unmute();
  }
}

// ДАННЫЕ ОТ ХОСТА (WebRTC-транспорт)

// обрабатывает входящий пакет: ArrayBuffer → кадр снапшота, строка → JSON-порт
function handleMessage(data) {
  // бинарный кадр (snapshot, порт SHOT_DATA) — в ядро: распаковка, вставка
  // в буфер по seq, reconciliation предикта по player-блоку
  if (data instanceof ArrayBuffer) {
    clientCore?.push_frame(new Uint8Array(data), performance.now());

    return;
  }

  // JSON-сообщение [portId, payload]
  const msg = unpacking(data);

  socketMethods[msg[0]](msg[1]);
}

// разрыв P2P: выход хоста = смерть комнаты (host-migration нет). Останавливаем
// рендер, показываем заглушку и возвращаемся в лобби перезагрузкой
function handleDisconnect() {
  Ticker.shared.remove(renderTick);

  for (const id in apps) {
    if (Object.hasOwn(apps, id)) {
      apps[id].stop();
    }
  }

  document.removeEventListener('visibilitychange', handleVisibilityChange);
  soundManager.destroy();
  modules.controls?.disableKeys();

  // если мы были хостом — гасим комнату: heartbeat, WebRTC-пиры, Worker
  if (hostHeartbeat) {
    clearInterval(hostHeartbeat);
    hostHeartbeat = null;
  }

  hostConnections?.destroy();
  hostController?.destroy();
  hostConnections = null;
  hostController = null; // останавливает и reconnect-петлю сигналинга
  hostRegistration = null;

  // терминальную причину закрытия (кик, полная комната) не затираем
  if (!terminalInformShown) {
    socketMethods[PS_TECH_INFORM_DATA](
      'Host left — the room is closed. Returning to lobby…',
    );
  }

  setTimeout(() => location.reload(), 3000);
}

// БУТСТРАП: лобби и установка P2P через мастер-сервер

let lobby = null;

// ресурсы роли хоста (комната в этой же вкладке)
let hostController = null;
let hostConnections = null;
let hostHeartbeat = null;

// dev-сборка (Vite подставляет константу): включает отладочный контур этапа 6
// плана plan/done/ai-debug — рекордер в комнате и window.__vimpDebug. В прод-бандле
// ветка вырезается сборкой, поведение не меняется
const isDevBuild =
  typeof import.meta.env !== 'undefined' && import.meta.env.DEV === true;

if (isDevBuild) {
  window.__vimpDebug = createDebugApi({
    getHostController: () => hostController,
    getClientCore: () => clientCore,
    reportUrl: lobbyConfig.debugReportUrl,
  });

  debugLog('window.__vimpDebug is available: dump, startRecording, stopRecording, divergence');
}

// WebRTC обязателен для P2P-игры. В Firefox RTCPeerConnection может
// отсутствовать (media.peerconnection.enabled = false, resistFingerprinting,
// приватные сборки) — честное сообщение вместо падения с чёрным экраном
function ensureWebRtcAvailable() {
  if (typeof RTCPeerConnection !== 'undefined') {
    return true;
  }

  socketMethods[PS_TECH_INFORM_DATA](
    'WebRTC is unavailable in this browser: P2P play is impossible. ' +
      'In Firefox check that media.peerconnection.enabled is on.',
  );

  return false;
}

// устанавливает P2P-соединение с выбранным хостом и уходит из лобби
function connectToHost(hostId) {
  if (!ensureWebRtcAvailable()) {
    return;
  }

  currentHostId = hostId;

  transport = new WebRtcManager(signaling, {
    iceServers: signaling.iceServers,
  });

  transport.publisher.on('message', handleMessage);
  transport.publisher.on('close', handleDisconnect);
  transport.connect(hostId);

  lobby.close();
}

// поднимает комнату в этой же вкладке (Worker хоста): хост-игрок играет через
// loopback, удалённые клиенты — по WebRTC (answerer). Клиентский код одинаков,
// отличается лишь транспорт. Выход хоста = смерть комнаты — как у клиента
async function connectAsHost(room) {
  // фича-детект вместо classic-фолбэка (запретил бы ESM/инлайн WASM,
  // см. PLAN.md риск №5): честная ошибка, join остаётся доступен
  if (!supportsModuleWorker()) {
    socketMethods[PS_TECH_INFORM_DATA](
      'This browser cannot be a host: ES module Web Workers are ' +
        'unsupported. You can still join existing rooms.',
    );

    return;
  }

  if (!ensureWebRtcAvailable()) {
    return;
  }

  // фактическая карта комнаты (из 'ready'; далее актуализируется map_changed)
  let currentMapName = null;

  // отладочный контур (этап 6): рекордер живого матча и хостовый CONSOLE-лог
  // поднимаются только в dev-сборке
  room.isDevMode = isDevBuild;

  // Этап 6.4: Worker грузит HostPlugin динамически по entries.host/entries.wasm
  // активной игры — движок больше не знает игру статически
  room.game = {
    id: activeGameManifest.id,
    version: activeGameManifest.version,
    hostEntryUrl: activeGameManifest.entries.host,
    wasmUrl: activeGameManifest.entries.wasm,
  };

  // Этап 5.1: комната стартует на актуальных картах мастера;
  // недоступность каталога некритична — Worker возьмёт карты из бандла
  try {
    const catalog = await fetchMasterMaps();

    room.maps = catalog.maps;
    hostMapsVersion = catalog.version;
  } catch (e) {
    console.warn('[maps] master catalog unavailable, using bundled maps:', e);
  }

  // Этап 5.2: Worker создаётся по манифесту мастера — бандл страницы после
  // деплоя исчезает из раздачи; без манифеста (dev) — бандловый URL,
  // обновления кода отключены
  let workerUrl = null;

  try {
    const manifest = await fetchWorkerManifest();

    // составной codeVersion (Этап 6.5): движок (worker-бандл) + игра
    // (id/version активного манифеста, с которым комната стартует)
    hostCodeVersion = {
      engine: manifest.version,
      game: { id: activeGameManifest.id, version: activeGameManifest.version },
    };
    workerUrl = manifest.url;
  } catch (e) {
    console.warn('[worker] master manifest unavailable, using bundled:', e);
  }

  hostController = new HostController(room, {
    workerUrl,
    onReady: readyMsg => {
      currentMapName = readyMsg?.mapName;

      // seed мира приезжает в 'ready' (этап 1): без него запись матча
      // невоспроизводима, поэтому он виден в консоли сразу
      if (isDevBuild) {
        debugLog('room ready', {
          map: currentMapName,
          seed: readyMsg?.seed,
        });
      }

      // периодический heartbeat/актуализация комнаты у мастера
      const update = () =>
        signaling.updateHost({
          currentPlayers: 1 + (hostConnections?.peerCount || 0),
          mapName: currentMapName,
        });

      // регистрация комнаты; повторно вызывается при reconnect сигналинга
      hostRegistration = () => {
        signaling.registerHost({
          name: room.name,
          maxPlayers: room.maxPlayers,
          mapName: currentMapName,
          gameId: room.game.id,
          gameVersion: room.game.version,
          token: lobbyAuthModel.getToken(),
        });

        clearInterval(hostHeartbeat);
        hostHeartbeat = setInterval(
          update,
          lobbyConfig.create.heartbeatInterval,
        );
      };

      hostRegistration();
    },

    // смена карты голосованием/таймером — сразу отразить в лобби мастера
    onMapChange: mapName => {
      currentMapName = mapName;
      signaling.updateHost({ mapName });
    },

    // Worker не поднялся (WASM/конфиг): гасим комнату и возвращаемся в лобби
    onError: msg => {
      handleDisconnect();
      socketMethods[PS_TECH_INFORM_DATA](
        `Failed to start the room: ${msg.message || 'unknown error'}. Returning to lobby…`,
      );
    },
  });

  // удалённые клиенты по WebRTC; актуализация currentPlayers при их вход/выходе
  hostConnections = new HostConnectionManager(signaling, hostController, {
    iceServers: signaling.iceServers,
    onPeersChange: count => signaling.updateHost({ currentPlayers: 1 + count }),
  });

  // хост-игрок в этой же вкладке (socketId согласован с kick-исключением)
  transport = new LoopbackTransport(
    hostController,
    lobbyConfig.create.hostSocketId,
  );

  transport.publisher.on('message', handleMessage);
  transport.publisher.on('close', handleDisconnect);
  transport.connect();

  // сигнальный WS хоста должен жить постоянно (офферы, heartbeat, выдача) —
  // при разрыве переподключаемся с бэкоффом; welcome вызовет re-register
  let reconnectAttempt = 0;

  signaling.publisher.on('close', () => {
    if (!hostController) {
      return; // комната уже погашена
    }

    const { baseDelay, maxDelay } = lobbyConfig.reconnect;
    const delay = Math.min(maxDelay, baseDelay * 2 ** reconnectAttempt);

    reconnectAttempt += 1;
    setTimeout(() => signaling.connect(), delay);
  });

  signaling.publisher.on('welcome', () => {
    reconnectAttempt = 0;
    hostRegistration?.();
  });

  // мастер отвечает актуальными версиями каталога карт и worker-бандла:
  // расхождение (деплой, пока комната жила) — подтянуть каталог к следующей
  // смене карты / заменить Worker эстафетой на границе раунда (Этап 5.2)
  signaling.publisher.on('host_registered', msg => {
    // кодревью №1 (plan/server-rating/review.md): hostId + per-room секрет не
    // известны Worker'у до этого момента — прокидываем их, чтобы PlayerDataSync
    // атрибутировал последующие rank/state-flush к этой комнате (секрет
    // доказывает мастеру владение hostId)
    hostController?.setHostId(msg.hostId, msg.hostSecret);

    if (msg.mapsVersion && msg.mapsVersion !== hostMapsVersion) {
      refreshHostMaps();
    }

    if (
      msg.codeVersion &&
      hostCodeVersion &&
      codeVersionChanged(msg.codeVersion, hostCodeVersion)
    ) {
      refreshHostWorker();
    }
  });

  // сигнал мастера об обновлении каталога карт/кода (hot-reload в будущем)
  signaling.publisher.on('update_available', msg => {
    if (!msg.mapsVersion || msg.mapsVersion !== hostMapsVersion) {
      refreshHostMaps();
    }

    if (
      msg.codeVersion &&
      hostCodeVersion &&
      codeVersionChanged(msg.codeVersion, hostCodeVersion)
    ) {
      refreshHostWorker();
    }
  });

  lobby.close();
}

// версия каталога карт мастера, с которой поднята комната (Этап 5.1)
let hostMapsVersion = null;

// составной codeVersion комнаты (Этап 5.2/6.5): { engine, game: { id, version } };
// null — обновления кода отключены (манифест недоступен при старте)
let hostCodeVersion = null;

// версия, своп на которую не удался — не ретраить её на каждом re-register
let failedCodeVersion = null;

// сравнимый ключ составного codeVersion (Этап 6.5): движок + игра —
// расхождение любой половины (деплой движка ИЛИ деплой игры) запускает эстафету
function codeVersionKey(cv) {
  return cv
    ? `${cv.engine ?? ''}:${cv.game?.id ?? ''}:${cv.game?.version ?? ''}`
    : null;
}

function codeVersionChanged(remote, local) {
  return codeVersionKey(remote) !== codeVersionKey(local);
}

// защита от параллельных эстафет Worker'ов
let workerSwapInProgress = false;

// повторная регистрация комнаты у мастера (reconnect сигналинга)
let hostRegistration = null;

// Этап 5.1/6.4: скачивает каталог карт мастера активной игры (манифест +
// все карты)
async function fetchMasterMaps() {
  const gameId = activeGameManifest.id;
  const manifestRes = await fetch(lobbyConfig.maps.manifestUrl(gameId));

  if (!manifestRes.ok) {
    throw new Error(`maps manifest: HTTP ${manifestRes.status}`);
  }

  const manifest = await manifestRes.json();

  const entries = await Promise.all(
    manifest.maps.map(async name => {
      const url = `${lobbyConfig.maps.baseUrl(gameId)}/${encodeURIComponent(name)}`;
      const res = await fetch(url);

      if (!res.ok) {
        throw new Error(`map ${name}: HTTP ${res.status}`);
      }

      return [name, await res.json()];
    }),
  );

  return { version: manifest.version, maps: Object.fromEntries(entries) };
}

// перечитывает каталог карт мастера и передаёт в Worker:
// применится со следующей смены карты (текущий раунд не трогается)
async function refreshHostMaps() {
  try {
    const catalog = await fetchMasterMaps();

    hostMapsVersion = catalog.version;
    hostController?.updateMaps(catalog.maps);
  } catch (e) {
    console.warn('[maps] refresh from master failed:', e);
  }
}

// Этап 5.2: скачивает манифест worker-бандла мастера ({ version, url })
async function fetchWorkerManifest() {
  const res = await fetch(lobbyConfig.worker.manifestUrl);

  if (!res.ok) {
    throw new Error(`worker manifest: HTTP ${res.status}`);
  }

  return res.json();
}

// Этап 6.5: перечитывает манифест активной игры мастера — своп не должен
// нести новому Worker'у закэшированный с момента создания комнаты
// hostEntryUrl/wasmUrl (деплой игры мог обновиться независимо от движка)
async function fetchGameManifest(gameId) {
  return fetchGamePluginManifest(lobbyConfig.game.manifestUrl(gameId));
}

// Этап 5.2/6.5: эстафета Worker'ов — новая версия кода (движка ИЛИ игры) у
// мастера. Worker заменяется на границе раунда без разрыва P2P; сбой свопа
// не смертелен — комната продолжает жить на прежней версии
async function refreshHostWorker() {
  if (workerSwapInProgress || !hostController) {
    return;
  }

  workerSwapInProgress = true;

  let manifest = null;
  let game = null;

  try {
    manifest = await fetchWorkerManifest();
    const gameManifest = await fetchGameManifest(activeGameManifest.id);

    game = {
      id: gameManifest.id,
      version: gameManifest.version,
      hostEntryUrl: gameManifest.entries.host,
      wasmUrl: gameManifest.entries.wasm,
    };

    const nextCodeVersion = {
      engine: manifest.version,
      game: { id: game.id, version: game.version },
    };
    const nextKey = codeVersionKey(nextCodeVersion);

    if (
      !manifest.version ||
      !manifest.url ||
      nextKey === codeVersionKey(hostCodeVersion) ||
      nextKey === codeVersionKey(failedCodeVersion)
    ) {
      return;
    }

    await hostController.swapWorker(manifest.url, game);

    hostCodeVersion = nextCodeVersion;
    failedCodeVersion = null;
    console.info(`[worker] room migrated to code version ${nextKey}`);
  } catch (e) {
    if (manifest?.version) {
      failedCodeVersion = { engine: manifest.version, game };
    }

    console.warn('[worker] swap to new version failed:', e);
  } finally {
    workerSwapInProgress = false;
  }
}

// REST-запрос списка серверов у мастера (поиск игнорирует пагинацию)
async function fetchServers({ offset, limit, search }) {
  const params = new URLSearchParams();

  if (search) {
    params.set('search', search);
  } else {
    params.set('offset', offset);
    params.set('limit', limit);
  }

  try {
    const res = await fetch(`${lobbyConfig.serversUrl}?${params}`);

    return res.ok ? await res.json() : null;
  } catch (e) {
    return null;
  }
}

// топ-N рейтинга игры (lobby-page-plan) — публичный эндпоинт, доступен и до
// логина, поэтому без Authorization
async function fetchLeaderboard(gameId) {
  const params = new URLSearchParams({
    game: gameId,
    limit: lobbyConfig.leaderboardLimit,
  });

  try {
    const res = await fetch(`${lobbyConfig.leaderboardUrl}?${params}`);

    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// позиция вызывающего в рейтинге игры (lobby-page-plan) — требует identity-
// токена, как и остальные /auth/* запросы игрока (rank/state)
async function fetchPlacement(gameId) {
  const token = lobbyAuthModel.getToken();

  if (!token) {
    return null;
  }

  try {
    const res = await fetch(
      `${lobbyConfig.placementUrl}?${new URLSearchParams({ game: gameId })}`,
      { headers: { authorization: `Bearer ${token}` } },
    );

    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// code review M1: токен актуальности запроса — переключение игры быстрее
// сетевого ответа не должно дать устаревшему ответу (например, от игры A)
// затереть уже выбранную игру B, если её собственный ответ пришёл раньше
let leaderboardReqId = 0;

// поля формы комнаты, сгенерированные по manifest.roomForm: key -> field
let roomFormFields = new Map();

// генерирует форму создания комнаты по явной схеме манифеста (roomForm,
// docs/en/plugin-api.md "Form schema") — движок не выводит контролы из типа
// значения, схема плагина полностью описывает форму
function populateRoomForm(manifest) {
  const container = document.getElementById(lobbyConfig.elems.fieldsId);

  if (!container) {
    return;
  }

  if (Array.isArray(manifest.roomForm)) {
    const descriptors = mergeRoomDefaults(
      manifest.roomForm,
      manifest.roomDefaults,
    );

    roomFormFields = buildForm(descriptors, container, {
      sources: { maps: manifest.maps?.list },
    });
  } else {
    // без явной схемы форма комнаты пустая — не выводим контролы из типа
    // значения (Часть 6 плана), но и не молчим об этом
    console.warn(
      `GameManifest "${manifest.id}" has no roomForm — room creation form will be empty`,
    );
    container.textContent = '';
    roomFormFields = new Map();
  }
}

// каталог манифестов по id (lobby-page-plan): достаточно для формы и
// leaderboard селектора игр — активная игра для host остаётся
// gamesManifest[0] (граница задачи, plan/lobby-page-plan.md)
const gamesById = new Map(gamesManifest.map(manifest => [manifest.id, manifest]));

// заполняет #lobby-game всем каталогом манифестов мастера (lobby-page-plan) —
// раньше туда попадал только gamesManifest[0], теперь селектор рабочий
function populateGameSelect() {
  const gameSelect = document.getElementById(lobbyConfig.elems.gameId);

  if (!gameSelect) {
    return;
  }

  gamesManifest.forEach(manifest => {
    const option = document.createElement('option');

    option.value = manifest.id;
    option.textContent = manifest.title;
    gameSelect.appendChild(option);
  });

  gameSelect.value = activeGameManifest.id;
}

// поднимает лобби после welcome от мастера (iceServers уже получены);
// повторный welcome (reconnect сигналинга хоста) лобби не пересоздаёт
function initLobby() {
  if (lobby) {
    return;
  }

  const lobbyModel = new LobbyModel(lobbyConfig);
  const lobbyView = new LobbyView(lobbyModel, lobbyConfig.elems);

  lobbyView.setLeaderboardLimit(lobbyConfig.leaderboardLimit);

  lobby = new LobbyCtrl(lobbyModel, lobbyView);

  // список серверов — REST-запросом к мастеру
  lobbyModel.publisher.on('fetch', async query => {
    const list = await fetchServers(query);

    if (list) {
      lobbyModel.setList(list, query.append);
    }
  });

  // умный пинг видимого сервера — сигнальным путём (замер приблизительный)
  lobbyModel.publisher.on('ping-request', ({ hostId, pingId }) => {
    signaling.pingHost(hostId, pingId);
  });

  signaling.publisher.on('pong_host', msg => {
    lobbyModel.resolvePong(msg.pingId, performance.now());
  });

  // выбор сервера → установка P2P
  lobbyModel.publisher.on('join', connectToHost);

  // Leaderboard (lobby-page-plan): контроллер сигнализирует, для какой игры
  // нужны свежие данные (смена #lobby-game или первое открытие вкладки).
  // code review M1: сброс до fetch'а — иначе данные предыдущей игры видны
  // под заголовком новой, пока не пришёл ответ (и остаются навсегда при
  // сетевом сбое); reqId отбрасывает ответ устаревшего запроса, если игру
  // переключили быстрее, чем пришёл ответ (latest-wins)
  lobby.publisher.on('leaderboard-needed', async gameId => {
    lobbyModel.clearLeaderboard();

    const reqId = ++leaderboardReqId;
    const [leaderboard, placement] = await Promise.all([
      fetchLeaderboard(gameId),
      fetchPlacement(gameId),
    ]);

    if (reqId !== leaderboardReqId) {
      return; // игру уже переключили ещё раз — этот ответ устарел
    }

    if (leaderboard) {
      lobbyModel.setLeaderboard(leaderboard);
    }

    if (placement) {
      lobbyModel.setPlacement(placement);
    }
  });

  // ник вызывающего (code review M4-остаток): нужен view, чтобы решить,
  // виден ли вызывающий уже в отрисованном топе Leaderboard, по членству в
  // списке, а не по числу placement (расходится с leaderboard.length при
  // ничьих на границе LIMIT). Ник неизменен на сессию — один вызов до
  // первого gameChanged/рендера Leaderboard
  lobbyView.setSelfNick(lobbyAuthModel.getNick());

  // создание комнаты в этой же вкладке (хост-игрок через loopback)
  populateGameSelect();
  populateRoomForm(activeGameManifest);
  lobby.gameChanged(activeGameManifest.id, activeGameManifest.title);

  // селектор игр (lobby-page-plan): работает с каталогом манифестов — меняет
  // форму создания комнаты и Leaderboard, но НЕ активную игру для host
  // (граница задачи, см. plan/lobby-page-plan.md)
  const gameSelect = document.getElementById(lobbyConfig.elems.gameId);

  const hostBtn = document.getElementById(lobbyConfig.elems.hostBtnId);

  gameSelect?.addEventListener('change', () => {
    const manifest = gamesById.get(gameSelect.value);

    if (!manifest) {
      return;
    }

    populateRoomForm(manifest);
    lobby.gameChanged(manifest.id, manifest.title);

    if (hostBtn) {
      const { disabled, title } = getHostGateState(manifest.id, activeGameManifest);

      hostBtn.disabled = disabled;
      hostBtn.title = title;
    }
  });

  const nameInput = document.getElementById(lobbyConfig.elems.nameId);

  hostBtn?.addEventListener('click', () => {
    // защита в глубину поверх hostBtn.disabled (code review lobby-page): клик
    // не должен создать комнату с полями формы чужой игры, даже если
    // disabled почему-то не выставился/был обойдён
    if (gameSelect && getHostGateState(gameSelect.value, activeGameManifest).disabled) {
      return;
    }

    // нативная валидация (pattern/required) — единственная граница
    // room-формы: она едет клиенту как JSON манифеста, JS-валидаторы
    // (как в auth-форме) туда не сериализуются (docs/en/plugin-api.md
    // "Form schema"); авторитетный клампинг всё равно в applyRoomOverrides.js
    // (вызывается из host.worker.js при создании комнаты)
    if (
      !reportFormValidity(document.getElementById(lobbyConfig.elems.fieldsId))
    ) {
      return;
    }

    const name =
      (nameInput?.value || '').trim() || lobbyConfig.create.defaultName;
    const { roomDefaults } = activeGameManifest;

    // дефолты манифеста перекрываются значениями сгенерированных полей
    const overrides = { ...roomDefaults };

    for (const [key, field] of roomFormFields) {
      overrides[key] = field.getValue();
    }

    connectAsHost({
      name,
      hostSocketId: lobbyConfig.create.hostSocketId,
      ...overrides,
    });
  });

  lobby.open();
}

// логин лобби (Этап B2): central auth-сервис выдаёт JWT, лобби открывается
// только после успешной авторизации (глобальный ник вместо свободного ввода
// в игре). Не зависит от сигнального сокета мастера — читает query string
// (OAuth-редирект) и localStorage независимо от 'welcome'
const lobbyAuthModel = new LobbyAuthModel(authClientConfig);
const lobbyAuthView = new LobbyAuthView(lobbyAuthModel, authClientConfig);
const lobbyAuthCtrl = new LobbyAuthCtrl(lobbyAuthModel, lobbyAuthView);

let welcomeReceived = false;
let authenticated = false;

function maybeInitLobby() {
  if (welcomeReceived && authenticated) {
    initLobby();
  }
}

signaling.publisher.on('welcome', () => {
  welcomeReceived = true;
  maybeInitLobby();
});

lobbyAuthModel.publisher.on('authenticated', () => {
  authenticated = true;
  maybeInitLobby();
});

if (lobbyAuthCtrl.init(window.location.search)) {
  window.history.replaceState(null, '', window.location.pathname);
}

signaling.connect();
