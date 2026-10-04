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
  bindLiveErrors,
} from './lib/formBuilder.js';
import { normalizeAuthParams } from './lib/authParams.js';
import { renderProjectLink } from './lib/footerLink.js';
import { createGameActivator } from './lib/gameActivator.js';
import createAutostart from './lib/autostart.js';
import { applyCatalogState } from './lib/catalogState.js';
import { getBootConfig, resolveBootConfig } from './boot.js';
import {
  ensureGameShell,
  ensureCanvas,
  showBootFailure,
} from './views/gameShell.js';
import { createContextTracker } from './lib/contextTracker.js';
import { createLocalPlayer } from './lib/localPlayer.js';
import { createAccolades } from './lib/accolades.js';
import { createDiagnostics } from './lib/diagnostics.js';
import { dispatchSocketMessage } from './lib/socketDispatch.js';
import { pickActiveGame, isGameAvailable } from './lib/pickActiveGame.js';
import { readCoreAbi, dispatchCoreOp, ABI_UNKNOWN } from '../lib/coreAbi.js';
import { ABI_OP_DEBUG_JSON } from '../config/abiOps.js';
import { createDebugApi, debugLog, DEBUG_PREFIX } from './debug.js';
import { buildClientCoreConfig } from '../lib/clientCoreConfig.js';
import { buildSnapshotKeysById } from '../lib/reconstructHot.js';
import Factory from '../lib/factory.js';
import { formatMessage } from '../lib/formatters.js';
import { sanitizeRoomSettings } from '../lib/roomSettings.js';
import { sanitizeMessage } from '../lib/sanitizers.js';
import { validateAuth } from '../lib/validators.js';
import SoundManager from './SoundManager.js';
import SignalingClient from './network/SignalingClient.js';
import WebRtcManager from './network/WebRtcManager.js';
import HostController from './network/HostController.js';
import HostConnectionManager from './network/HostConnectionManager.js';
import HostPrewarm from './network/HostPrewarm.js';
import HiddenHostHealthLog from './network/HiddenHostHealthLog.js';
import HostHealthPolicy from './network/HostHealthPolicy.js';
import HostHealthReporter from './network/HostHealthReporter.js';
import RoomPeersReporter from './network/RoomPeersReporter.js';
import TokenHandoffTimer from './network/TokenHandoffTimer.js';
import Promotion, {
  savePendingPromotion,
  takePendingPromotion,
} from './network/Promotion.js';
import StandbyReceiver from './network/StandbyReceiver.js';
import StandbySender from './network/StandbySender.js';
import PlannedHandoff, {
  controlsAfterAbort,
} from './network/PlannedHandoff.js';
import LoopbackTransport from './network/LoopbackTransport.js';
import WebSocketTransport from './network/WebSocketTransport.js';
import InlineHostBridge from './network/InlineHostBridge.js';
import SessionSupervisor, {
  SESSION_STATES,
} from './network/SessionSupervisor.js';
import { supportsModuleWorker } from './network/workerSupport.js';
import {
  buildHostCaps,
  canHostIn,
  tokenAllowsHosting,
} from './lib/hostCaps.js';
import FpsMeter from './lib/FpsMeter.js';
import HostUnloadGuard from './lib/hostUnloadGuard.js';
import { createPageReload } from './lib/pageReload.js';
import {
  decideInvalidToken,
  decideUnknownRoom,
} from './lib/signalingErrors.js';
import JoinRetry from './lib/JoinRetry.js';
import {
  isKickClose,
  POLICY_CLOSE_INFORMS,
  shouldReloadAfterClose,
} from './network/policyClose.js';
import LobbyModel from './components/model/Lobby.js';
import LobbyView from './components/view/Lobby.js';
import LobbyCtrl from './components/controller/Lobby.js';
import LobbyAuthModel from './components/model/LobbyAuth.js';
import LobbyAuthView from './components/view/LobbyAuth.js';
import LobbyAuthCtrl from './components/controller/LobbyAuth.js';
import GamesModel from './components/model/Games.js';
import GamesView from './components/view/Games.js';
import GamesCtrl from './components/controller/Games.js';
import ClientReportsModel from './components/model/ClientReports.js';
import ClientReportsView from './components/view/ClientReports.js';
import ClientReportsCtrl from './components/controller/ClientReports.js';
import RoomMenuModel from './components/model/RoomMenu.js';
import RoomMenuView from './components/view/RoomMenu.js';
import RoomMenuCtrl from './components/controller/RoomMenu.js';
import {
  absoluteLink,
  decideExitRoute,
  decideRouteAction,
  formatGameLink,
  formatRoomLink,
  classifyRoomPoll,
  parseRoute,
  pickQuickPlayRoom,
  quickPlayCreateDelay,
  setRoute,
} from './lib/roomLink.js';
import {
  CHANGE_HOST_VALUES,
  CHANGE_HOST_VOTE,
  answerValue,
  changeHostTitle,
  parseChangeHost,
  rejectionMessageKey,
  resultMessage,
} from './lib/hostVoteCommand.js';
import BakingProvider from './providers/BakingProvider.js';
import DependencyProvider from './providers/DependencyProvider.js';
import wsports from '../config/wsports.js';
import GAME_CODES from '../config/gameCodes.js';
import { buildSystemMessage } from '../host/meta/modules/chat/systemMessages.js';
import {
  fetchGamesManifest,
  fetchGameManifest as fetchGamePluginManifest,
  loadClientPlugin,
} from '../lib/gamePlugin.js';
import lobbyConfig from '../config/lobby.js';
import authClientConfig from '../config/authClient.js';
import clientDefaults from '../config/clientDefaults.js';
import applyCamera from './lib/applyCamera.js';
import runHotTick from './lib/hotTick.js';

// Динамическая загрузка игры по каталогу мастера (Этап 6.3): ClientPlugin
// (parts, bakers, игровой CSS, хуки ядра) грузится по entries.client манифеста
// — движок не импортирует игру статически. Первой активируется gamesManifest[0]
// (или boot.gameId), но активная игра не заморожена: выбор в #lobby-game и
// вход в чужую комнату переключают её через gameActivator (см. bindActiveGame).
// Переключение безопасно ровно до старта матча: всё пер-игровое состояние
// (Factory, Pixi-приложения, clientCore, звук) появляется только в CONFIG_DATA,
// а после матча lobby-режим перезагружает страницу
let activeGameManifest;
let clientPlugin;
let gamesManifest;

// почему активной игры нет, если каталог непуст: строка отказа лобби вместо
// общего «игр пока не опубликовано» (см. pickActiveGame)
let catalogProblem = null;

// узел игрового CSS: при переключении игры его текст заменяется, иначе стили
// двух игр жили бы в head одновременно и конфликтовали селекторами
let gameStyleNode = null;

// единственная точка присвоения активной игры — и в бутстрапе, и при
// переключении в лобби
function bindActiveGame(manifest, plugin) {
  activeGameManifest = manifest;
  syncDiagnosticsGame();
  clientPlugin = plugin;

  if (!gameStyleNode) {
    gameStyleNode = document.createElement('style');
    document.head.append(gameStyleNode);
  }

  gameStyleNode.textContent = plugin.styles ?? '';
}

// режим загрузки (Этап 2 плана standalone-sdk): lobby — прод с мастером,
// solo — хост в этой же вкладке (standalone SDK), dedicated — прямой WS к
// Node-серверу. Ветвлений ровно пять: манифест, сигналинг/лобби, транспорт,
// авто-аутентификация и точка монтирования канвасов.
//
// каталог манифестов нужен только лобби-контуру, а его запрос не зависит от
// ответа /config — пускаем оба в полёт разом, иначе старт лобби платит лишний
// последовательный round-trip
const injectedBoot = getBootConfig();
const manifestPromise = injectedBoot
  ? null
  : fetchGamesManifest(lobbyConfig.gamesManifestUrl).catch(err => err);

const boot = injectedBoot ?? (await resolveBootConfig());
const bootMode = boot.mode;
const isLobbyMode = bootMode === 'lobby';

// журнал клиентских ошибок (plan/client-reports): ставится как можно
// раньше, чтобы ловить и сбои самого старта. Лобби и dedicated шлют на
// свой бокс; SDK (solo) — только если встраивающий передал reportUrl
const diagnostics = createDiagnostics({
  url:
    bootMode === 'solo'
      ? (boot.reportUrl ?? null)
      : lobbyConfig.clientReportUrl,
  context: {
    mode: bootMode,
    role: 'client',
    gameId: null,
    gameVersion: null,
    page: location.pathname.slice(0, 128),
    userAgent: navigator.userAgent.slice(0, 256),
  },
});

diagnostics.install(window);

// игра в контексте отчётов — после каждой смены активного манифеста
function syncDiagnosticsGame() {
  diagnostics.setContext({
    gameId: activeGameManifest?.id ?? null,
    gameVersion: activeGameManifest?.version ?? null,
  });
}

// точка монтирования игрового интерфейса: в lobby-режиме разметку даёт pug и
// каркас ничего не делает, в solo — собирается в контейнере SDK
const gameContainer = boot.container ?? document.body;

ensureGameShell(gameContainer);

try {
  if (boot.manifest) {
    // SDK передаёт манифест-подобный объект в памяти — каталога мастера нет
    activeGameManifest = boot.manifest;
    syncDiagnosticsGame();
    gamesManifest = [activeGameManifest];
  } else {
    gamesManifest = await manifestPromise;

    // отказ запроса доехал значением (промис стартовал раньше try) —
    // возвращаем его в обычный поток ошибок загрузки
    if (gamesManifest instanceof Error) {
      throw gamesManifest;
    }

    try {
      // недоступная игра активной быть не может (lib/pickActiveGame.js)
      activeGameManifest = pickActiveGame(gamesManifest, boot.gameId);
      syncDiagnosticsGame();
    } catch (e) {
      // «каталог непустой, но играбельного в нём нет» (движок обновили, все
      // опубликованные игры просят возможность, которой в нём уже нет) — для
      // лобби это то же самое, что пустой каталог: играть не во что, но
      // модерация и заявка на месте, и только они это чинят. Терять их из-за
      // такого нельзя, поэтому причина едет строкой отказа лобби, а не
      // терминальным оверлеем. В solo/dedicated отказ остаётся отказом
      if (!isLobbyMode) {
        throw e;
      }

      catalogProblem = e.message;
    }
  }

  // пустой каталог — состояние лобби, а не отказ загрузки: модератор вправе
  // отключить последнюю игру, реестр вправе ещё ничего не одобрить, и вернуть
  // каталог к жизни можно только из панели, которая живёт в этой же вкладке.
  // В solo/dedicated игры нет — это отказ: там весь смысл вкладки в матче
  if (!activeGameManifest && !isLobbyMode) {
    throw new Error('master has no games in its catalog');
  }

  if (activeGameManifest) {
    bindActiveGame(
      activeGameManifest,
      boot.clientPlugin ?? (await loadClientPlugin(activeGameManifest)),
    );
  }
} catch (e) {
  showBootFailure(`Failed to load the game: ${e.message}`, gameContainer);
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
const PS_ACCOLADES_DATA = wsports.server.ACCOLADES_DATA;
const PS_SESSION_DATA = wsports.server.SESSION_DATA;
const PS_RESUME_RESULT = wsports.server.RESUME_RESULT;

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
const PC_LEAVE = wsports.client.LEAVE;

// сигнальный WebSocket мастера (лобби + установка P2P); игровой трафик идёт
// по WebRTC (transport), не через мастер
// (только lobby: solo и dedicated мастера не имеют вовсе)
const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const signaling = isLobbyMode
  ? new SignalingClient(`${wsProtocol}//${location.host}/`)
  : null;

// супервизор сессии (host-migration этап 4): держит текущий транспорт к
// хосту и переживает его обрыв — переподключается и возвращает место в
// матче. Создаётся при входе в комнату (или в solo/dedicated-матч)
let supervisor = null;

// оверлей «Reconnecting…» на время переподключения (только лобби-режим)
const sessionOverlay = document.getElementById('session-overlay');
const sessionOverlayText = document.getElementById('session-overlay-text');

const modules = {};

// создание и инициализация SoundManager
const soundManager = new SoundManager();
let soundData = {};

const inputListener = new InputListener();

let modulesConfig = {};
let initIdList = [];
const apps = {};

// контекст рендера каждого полотна: нужен для перепечки ассетов после
// восстановления WebGL-контекста (весь видимый контент — RenderTexture без
// CPU-источника, сами по себе они не воскресают)
const renderContexts = {};

// последний payload MAP_DATA: карта пересобирается из него при восстановлении
// контекста (хост её повторно не пришлёт)
let lastMapData = null;

// dev-сборка (Vite подставляет константу): включает отладочный контур этапа 6
// плана plan/done/ai-debug — рекордер в комнате и window.__vimpDebug. В прод-бандле
// ветка вырезается сборкой, поведение не меняется
const isDevBuild =
  typeof import.meta.env !== 'undefined' && import.meta.env.DEV === true;

// рендер снят с тикера на время потери контекста (состояние — по полотнам)
const contextTracker = createContextTracker();

// renderTick на тикере: Ticker.add дубликаты не отсеивает, а добавить его
// могут и runModules, и восстановление контекста
let renderTickAttached = false;

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
// ключ последнего терминального tech-кода: по нему лобби-режим отличает кик
// (policyClose.isKickClose) от закрытия комнаты — в P2P кода закрытия нет
let terminalTechKey = null;
// снятие предыдущего animationend-листенера логотипа при повторном
// playLogoRoundStart — иначе листенеры копятся при частых стартах раунда
let logoAnimationEndHandler = null;

const CTRL = {}; // контроллеры
let gameSets = {}; // наборы конструкторов (id: [наборы])
let entitiesOnCanvas = {}; // сущности, отображаемые на полотнах
let currentMapSetId; // текущий id набора конструкторов для карт
const socketMethods = []; // методы для обработки сокет-данных

// модули матча запущены (AUTH_RESULT без ошибки): повторный успешный
// AUTH_RESULT в живой сессии — ошибка протокола
let sessionStarted = false;

// клиентское ядро (WASM, срез 2.6): интерполяция снапшотов, предикт своего
// танка, визуальный спавн выстрелов и распаковка кадров v3 — создаётся при
// получении конфига; wasm — результат init() для zero-copy чтения памяти
let clientCore = null;
let wasm = null;

// возможности загруженного клиентского ядра ({ abi, core, ops }) —
// читаются один раз при создании ядра, а не в момент вызова. Ядро старше
// самоописания даёт поколение 0 с пустым списком опкодов: это не ошибка,
// а игра, собранная до появления механизма (И2 плана plugin-forward-compat)
let clientCoreAbi = ABI_UNKNOWN;

// сервис пула зависимостей: «эта сущность моя или чужая?». Ядро читается
// геттером — оно создаётся позже пула сервисов (см. lib/localPlayer.js)
const localPlayer = createLocalPlayer(() => clientCore);
// сервис пула зависимостей: «какое место у этой сущности в глобальном
// топе?». Места считает хост, part рисует за них знак (см. lib/accolades.js)
const accolades = createAccolades();
let inputSeq = 0; // номер отправленного ввода (KEYS_DATA)

// обратный индекс снапшот-схемы игры (CONFIG_DATA.snapshot):
// keyId → { key, kind, width } — раскладку hot-буфера диктует схема,
// движковый бандл её не знает
let snapshotKeysById = null;

// SOCKET МЕТОДЫ

// config data
socketMethods[PS_CONFIG_DATA] = async data => {
  // повторное рукопожатие в живой сессии (например, хост не понял resume)
  // построило бы второе ядро и второй Application поверх первых
  if (clientCore) {
    handleProtocolError('CONFIG_DATA');
    return;
  }

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
  clientCoreAbi = readCoreAbi(core, 'client core');

  // инициализация сущностей игры
  for (const entity of Object.keys(entitiesOnCanvas)) {
    Factory.add({ [entity]: clientPlugin.parts[entity] });
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

  // сервисы игры для её же parts: движок их не описывает и не использует —
  // это доступ к тому, что живёт в игровом ядре (например, геометрия
  // предсказанной динамики карты). Собираются один раз на ядро; полотно,
  // которому сервис не объявлен в componentDependencies, его не получит
  const gameServices = clientPlugin.hooks.services?.(clientCore) || {};

  // создание полотен игры: canvas-элементы генерируются из конфига
  // канвасов игры (в HTML их нет)
  const canvasesConfig = modulesConfig.canvasManager.canvases;

  const initPromises = Object.keys(canvasesConfig).map(async canvasId => {
    const canvas = ensureCanvas(
      canvasId,
      canvasesConfig[canvasId],
      gameContainer,
    );

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

    // пул всех доступных сервисов в этом контексте (движковые плюс игровые:
    // об игровых движок не знает ничего — их отдаёт плагин, см. gameServices)
    const availableServices = {
      ...gameServices,
      renderer: app.renderer,
      soundManager,
      // «свой ли это персонаж»: part сравнивает id своего экземпляра (четвёртый
      // аргумент конструктора) со своим gameId. Игра без этого сервиса звучит
      // одинаково за всех — чужие подборы и чужие смерти вперемешку со своими
      localPlayer,
      // места в глобальном топе: знак за место рисует part игры, движок
      // раздаёт только числа (см. lib/accolades.js)
      accolades,
      // база ассетов игры — тем же каналом, что и путь к звукам (см. выше):
      // картинки карт живут в пакете игры (dist/img/), движок их не раздаёт.
      // part, объявивший сервис в componentDependencies, строит URL сам —
      // движок не знает ни имён файлов, ни их раскладки внутри пакета
      assetsBase: activeGameManifest.assetsBase,
      // журнал клиентских ошибок для партов игры (plan/client-reports):
      // warn(code, details) — своё предупреждение, capture(error) — пойманная
      // ошибка. Сервис опционален: игра не пишет его в requires
      diagnostics: {
        warn: (code, details) =>
          diagnostics.warn(code, details, { source: 'plugin' }),
        capture: error => diagnostics.capture(error, { source: 'plugin' }),
      },
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
    renderContexts[canvasId] = { app, assetProvider, bakingArr };

    canvas.addEventListener('webglcontextlost', handleContextLost);
    canvas.addEventListener('webglcontextrestored', handleContextRestored);
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

  // футер формы входа: версия и ссылка пакета ИГРЫ. Здесь, а не в AuthView:
  // его elems приходят из authSchema.elems игрового плагина, и футер каркаса
  // — не его забота. Метаданные кладёт в манифест мастер (GameCatalog читает
  // package.json пакета); в standalone-манифесте их может не быть — тогда
  // ячейки пустые, раскладку space-between это не ломает
  const authVersion = document.getElementById('auth-version');

  if (authVersion) {
    authVersion.textContent = activeGameManifest?.packageVersion ?? '';
  }

  renderProjectLink(
    document.getElementById('auth-package-link'),
    activeGameManifest?.packageUrl,
  );

  // память клиента (localStorage) + принудительное значение поля с
  // единственным вариантом. Здесь, а не в AuthView: solo-путь ниже отвечает
  // хосту вообще без формы и обязан прийти к тем же значениям
  normalizeAuthParams(params);

  // solo: формы нет — отвечаем дефолтами схемы, перекрытыми boot.autoAuth
  if (boot.autoAuth) {
    sending(PC_AUTH_RESPONSE, { ...defaultsFrom(params), ...boot.autoAuth });

    return;
  }

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
    sending(PC_AUTH_RESPONSE, { ...data, token: lobbyAuthModel?.getToken() });
  });

  modules.auth.init(params);
};

// значения формы по умолчанию (schema → { name: value }): база авто-ответа
function defaultsFrom(params) {
  return Object.fromEntries(params.map(param => [param.name, param.value]));
}

// auth errors
socketMethods[PS_AUTH_RESULT] = async err => {
  if (modules.auth) {
    modules.auth.parseRes(err);
  } else if (err) {
    // авто-аутентификация отбита хостом: формы, куда вернуть ошибку, нет
    socketMethods[PS_TECH_INFORM_DATA](
      `Authorization rejected: ${JSON.stringify(err)}`,
    );

    return;
  }

  if (!err) {
    if (sessionStarted) {
      handleProtocolError('AUTH_RESULT');
      return;
    }

    sessionStarted = true;
    await soundManager.init(soundData);
    runModules(modulesConfig);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    for (const id of initIdList) {
      const elem = document.getElementById(id);

      if (elem) {
        elem.style.display = id === 'panel' ? 'flex' : 'block';
      }
    }

    roomMenu?.setInPanel(initIdList.includes('panel'));

    sending(PC_MODULES_READY);

    // вход в комнату состоялся — мастер узнаёт состав комнаты от участника
    // (хост — участник своей комнаты с register_host)
    if (currentRoomId && !hostController) {
      sendJoinRoom();
    }
  }
};

// map data
socketMethods[PS_MAP_DATA] = data => {
  lastMapData = data;

  // карта пакета возобновления (host-migration): участник уже в матче —
  // это не загрузка (setLoading закончил бы пакет), MAP_READY хост не ждёт.
  // Признак — метка хоста, не supervisor.resuming: неготовому участнику
  // (карта сменилась за паузу) хост в том же окне шлёт обычную загрузку
  if (data?.resume === true) {
    applyMapData(data, { notifyHost: false });
    return;
  }

  // хост законно молчит до первого кадра новой карты (сторожок тишины)
  supervisor?.setLoading(true);
  applyMapData(data);
};

// собирает карту по payload MAP_DATA. notifyHost=false — пересборка после
// восстановления WebGL-контекста: повторный MAP_READY сломал бы машину
// состояний портов (хост его больше не ждёт)
function applyMapData(data, { notifyHost = true } = {}) {
  const { scale, layers, map, step, setId, spriteSheet, physicsStatic } = data;

  // ядру — мир для raycast выстрелов (+сброс буфера кадров и предикта)
  try {
    clientCore?.set_map(
      JSON.stringify({
        map,
        step,
        scale,
        setId,
        physicsStatic,
        physicsDynamic: data.physicsDynamic,
        // 2.5D: надземные уровни и переходы. Клиентское ядро строит из них
        // ту же `MapLevels`, что и хост, — иначе предсказание уровня
        // разъедется с авторитетным молча
        levels: data.levels,
        ramps: data.ramps,
        // высота уровня в мировых единицах: от неё зависит уклон рампы, а
        // значит и предсказание подъёма. Не доехав до клиентской `MapLevels`,
        // она дала бы другой уклон, чем у хоста, — расхождение молчаливое
        levelHeight: data.levelHeight,
        // непрозрачные данные игры: движок их не читает и не масштабирует
        game: data.game,
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

  // рендер-слои по уровням: уровень 0 — из `layers` над гридом `map`,
  // надземные — из `levels[n].layers` над гридом `levels[n].map`.
  // Ключи `s0..sN` сквозные: парт получает `level`, `solid` и `floor`
  // своего уровня и не обязан ничего знать про соседний
  const staticData = {};
  let staticIndex = 0;

  // мировых единиц на уровень — величина ФИЗИКИ: по ней ядро считает
  // уклон рампы и падение. Вертикальный масштаб КАРТИНКИ задаёт игра
  // (у танков — `parallax.shear`) и намеренно не зависит от карты, иначе
  // слои разных карт разъезжались бы по виду. Поле едет в парт как есть —
  // партам, которые мерят высоту в мировых единицах.
  // 0/undefined — движок подставил размер тайла
  const levelHeight = (Number(data.levelHeight) || step) * scale;

  const pushLayers = (levelLayers, levelMap, level, solid, floor, volumes) => {
    for (const [layer, tiles] of Object.entries(levelLayers || {})) {
      staticData[`s${staticIndex}`] = {
        type: 'static',
        spriteSheet,
        map: levelMap,
        step,
        layer,
        tiles,
        level,
        solid,
        floor,
        // визуальная высота слоя в уровнях: ядро её не знает, поле едет из
        // карты прямо в парт. 0 — слой плоский
        volume: Number(volumes?.[layer]) || 0,
        levelHeight,
        // прогоны рамп ЭТОГО уровня как объявлены в карте
        // ({ tile, dir, from, to }): парт строит по ним клин с нарастающей
        // высотой — грид уровня у него уже есть
        ramps: (data.ramps || []).filter(ramp => (ramp.from ?? 0) === level),
        // прежнее имя оставлено для парта, который его уже читает
        physicsStatic,
        scale,
        // непрозрачные данные игры (`map.game`) как объявлены в карте: без
        // масштабирования. `physicsDynamic[i].game` доезжает до `d{i}` сам
        game: data.game,
      };

      staticIndex += 1;
    }
  };

  pushLayers(layers, map, 0, physicsStatic, [], data.volumes);

  for (const [key, levelData] of Object.entries(data.levels || {})) {
    const level = Number(key);

    pushLayers(
      levelData.layers,
      levelData.map,
      level,
      levelData.walls || [],
      levelData.floor || [],
      levelData.volumes,
    );
  }

  removeMap(currentMapSetId);
  createMap(setId, staticData);

  if (notifyHost) {
    sending(PC_MAP_READY);
  }
}

// первый shot сразу после загрузки карты (JSON; порт 5 идёт бинарным путём);
// применяется немедленно (создание сущностей), в буфер интерполяции не пушится
socketMethods[PS_FIRST_SHOT_DATA] = data => {
  const [game, camera] = data;

  applyShot(game, camera);
  supervisor?.setLoading(false);

  // кадр пакета возобновления (host-migration этап 4): участник уже в
  // матче — подтверждать нечего, разовый автостарт уже отработал
  if (supervisor?.resuming) {
    return;
  }

  // подтверждение получения первого шота
  sending(PC_FIRST_SHOT_READY);
  supervisor?.enterGame();

  // solo: выход из наблюдателей и чат-команды игры (боты) — см. autostart.js
  runAutostart();
};

// отложенная задача автостарта: исполняется на первом renderTick
let pendingAutostart = null;

const runAutostart = createAutostart({
  votes: boot.startupVotes ?? [],
  commands: boot.startupCommands ?? [],
  sendVote: data => sending(PC_VOTE_DATA, data),
  sendCommand: message => sending(PC_CHAT_DATA, message),
  schedule: fn => {
    pendingAutostart = fn;
  },
});

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

// accolades data: места участников в глобальном топе, сам топ и место
// игрока в нём. Рассылка приходит от ХОСТА и только когда что-то из этого
// изменилось — в матче клиент за топом к мастеру не ходит (см.
// client/lib/accolades.js)
socketMethods[PS_ACCOLADES_DATA] = data => {
  accolades.apply(data);
  // stat в режиме 'leaderboard' рисует ровно эту таблицу
  modules.stat?.applyAccolades?.();
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
      terminalTechKey = terminalInformShown ? key : null;
    } else {
      message = data;
    }

    modules.controls?.disableKeys();
    techInformer.textContent = message;
    techInformer.style.display = 'block';
  } else {
    modules.controls?.enableKeys();
    terminalInformShown = false;
    terminalTechKey = null;
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

// session data: секрет места в матче (host-migration этап 4) — с ним
// супервизор вернётся после обрыва. Последнее сообщение пакета
// возобновления: набор клавиш в пакете уже пришёл, и удерживаемые клавиши,
// которые хост отпустил на время паузы, можно нажать снова
socketMethods[PS_SESSION_DATA] = data => {
  if (supervisor?.setSession(data ?? {})) {
    modules.controls?.resendHeld();
  }
};

// resume result: ответ хоста на RESUME_REQUEST
socketMethods[PS_RESUME_RESULT] = data => {
  supervisor?.resumeResult(data);
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

// Камеру с NaN/undefined applyCamera не применяет (lib/applyCamera.js), но
// молчать о ней нельзя: это симптом сбоя выше по течению (ядро, чтение
// hot-буфера), и журнал — единственный способ узнать о нём с прода.
// String(): JSON.stringify превратил бы NaN в null, а undefined потерял бы
function reportBadCamera(camera) {
  diagnostics.warn(
    'engine.camera.non-finite',
    { x: String(camera[0]), y: String(camera[1]) },
    { source: 'client' },
  );
}

// применяет кадр целиком (первый кадр и дискретные кадры интерполяции)
function applyShot(game, camera) {
  applyGameData(game);
  applyCamera(modules.canvasManager, soundManager, camera, reportBadCamera);
}

// рендер-тик: ядро выдаёт пересечённые кадры (события, создания/удаления)
// JSON-очередью, а горячие позиции (танки/динамика/камера + предсказанный
// свой танк) — плоским Float32-буфером zero-copy из памяти WASM; порядок
// чтения буфера — в lib/hotTick.js
function renderTick() {
  if (!clientCore) {
    return;
  }

  // автостарт solo — на первом кадре после FIRST_SHOT_READY, а не в том же
  // синхронном вызове
  if (pendingAutostart) {
    const task = pendingAutostart;

    pendingAutostart = null;
    task();
  }

  runHotTick({
    core: clientCore,
    memory: wasm.memory,
    snapshotKeysById,
    now: performance.now(),
    applyShot,
    applyGameData,
    applyCamera: camera =>
      applyCamera(modules.canvasManager, soundManager, camera, reportBadCamera),
  });

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

  // режим 'leaderboard' (snakes-v3 этап 4) рисует топ, привезённый хостом:
  // ни одного запроса из матча — сервисы, а не сеть
  const statModel = new StatModel(statData.params, {
    accolades,
    localPlayer,
    getNick: () => lobbyAuthModel?.getNick() ?? null,
  });

  // StatView генерирует шапку и таблицы по схеме игры ({ elems, params })
  const statView = new StatView(statModel, statData);

  modules.stat = new StatCtrl(statModel, statView);

  //==========================================//
  // Vote Module
  //==========================================//

  const voteModel = new VoteModel({ ...voteData.params, formatMessage });
  const voteView = new VoteView(voteModel, voteData.elems, gameContainer);

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
    'pointerAction',
    modules.controls.addPointer.bind(modules.controls),
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

  // указатель: экранная точка -> мировая (камера и масштаб полотна знает
  // только движок), дальше тем же портом, что и клавиши
  controlsModel.publisher.on('aim', ({ x, y, flags }) => {
    const world = modules.canvasManager.toWorld(x, y);

    if (!world) {
      return;
    }

    const wx = Math.round(world.x * 100) / 100;
    const wy = Math.round(world.y * 100) / 100;

    inputSeq = (inputSeq + 1) >>> 0;
    clientCore?.apply_aim?.(wx, wy, flags, performance.now());

    // формат wire: 'seq:aim:x:y:flags' рядом с 'seq:action:name'
    sending(PC_KEYS_DATA, `${inputSeq}:aim:${wx}:${wy}:${flags}`);
  });
  chatModel.publisher.on('socket', handleChatSend);
  voteModel.publisher.on('socket', handleVoteSend);

  //==========================================//
  // Рендер-цикл интерполяции
  //==========================================//

  startRenderLoop();
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
  supervisor?.send(JSON.stringify([name, data]), reliable);
}

// отправка сообщения чата хосту (точка перехвата команд, адресованных
// мастеру, а не хосту)
function handleChatSend(message) {
  const changeHost = parseChangeHost(message, bootMode);

  if (changeHost === null) {
    sending(PC_CHAT_DATA, message);
    return;
  }

  // голосование «Change host» считает мастер (этап 10): хост не должен
  // видеть и не может заблокировать голосование против себя
  const notice = key => modules.chat?.add(buildSystemMessage(key));

  if (changeHost === 'usage') {
    notice('HOST_VOTE_USAGE');
  } else if (hostController) {
    notice('HOST_VOTE_IS_HOST');
  } else if (!signaling?.connected || !currentRoomId) {
    notice('HOST_VOTE_OFFLINE');
  } else {
    signaling.hostVoteStart(currentRoomId);
  }
}

// ответ в окне голосования: «Change host?» — мастеру, остальное — хосту
function handleVoteSend(data) {
  if (Array.isArray(data) && data[0] === CHANGE_HOST_VOTE) {
    const value = answerValue(data[1]);

    if (hostVote && value && signaling?.connected) {
      signaling.hostVoteAnswer({ ...hostVote, value });
    }

    return;
  }

  sending(PC_VOTE_DATA, data);
}

// распаковывает данные
function unpacking(pack) {
  return JSON.parse(pack);
}

// дольше, чем интерполятор способен удержать буфер: после такой паузы
// кадры всё равно подрезаны, а часы устарели. Короткий alt-tab ресинка не
// стоит — он выбрасывает валидный буфер вместе с событийными кадрами
// (создание/удаление сущностей), и сцена замирает на delay + пару кадров
const RESYNC_AFTER_HIDDEN_MS = 3000;

// вкладка могла быть скрыта уже в момент навешивания слушателя — события
// 'hidden' тогда не будет, а пауза всё равно идёт
let hiddenAt = document.visibilityState === 'hidden' ? performance.now() : null;

// обработчик видимости вкладки
function handleVisibilityChange() {
  // если вкладка неактивна, выключение звука
  if (document.visibilityState === 'hidden') {
    hiddenAt = performance.now();
    soundManager.mute();
    // иначе включение звука при возвращении (кроме паузы переподключения и
    // смены хоста — его включит возобновление сессии)
  } else {
    if (!isSessionPaused()) {
      soundManager.unmute();
    }

    const hiddenMs = hiddenAt === null ? 0 : performance.now() - hiddenAt;

    hiddenAt = null;

    // после длинной паузы часы интерполятора устарели: пересеять оффсет
    // точно, а не догонять EMA десятки кадров. Опциональный вызов —
    // старая сборка плагина метода не имеет
    if (hiddenMs >= RESYNC_AFTER_HIDDEN_MS) {
      clientCore?.resync?.();
    }

    if (isDevBuild) {
      for (const id in renderContexts) {
        if (Object.hasOwn(renderContexts, id)) {
          const { app } = renderContexts[id];

          debugLog('visible', {
            canvas: id,
            contextLost: app.renderer.gl?.isContextLost?.(),
            size: [app.canvas.width, app.canvas.height],
            stageScale: app.stage.scale.x,
            stagePos: [app.stage.position.x, app.stage.position.y],
            tickerStarted: Ticker.shared.started,
          });
        }
      }

      debugLog('clientCore', clientCoreDebug());
    }
  }
}

// дамп клиентского ядра: сначала опкод dispatch, затем замороженный метод.
// Метод не удаляется никогда (И1), поэтому запасной путь остаётся навсегда:
// ядро, собранное до появления dispatch, отдаёт дамп по-старому.
// dispatchCoreOp — та же точка вызова, что у хостового GameCoreAdapter._op:
// имя опкода читается из реестра, три исхода ответа различимы
function clientCoreDebug() {
  if (!clientCore) {
    return undefined;
  }

  const { handled, bytes } = dispatchCoreOp(
    clientCore,
    clientCoreAbi,
    ABI_OP_DEBUG_JSON,
  );

  if (handled && bytes !== null) {
    return new TextDecoder().decode(bytes);
  }

  return clientCore.debug_json?.();
}

// единая точка управления рендер-циклом: Ticker.add дубликаты не отсеивает,
// а добавить renderTick могут и runModules, и восстановление контекста
function startRenderLoop() {
  if (renderTickAttached) {
    return;
  }

  Ticker.shared.add(renderTick);
  renderTickAttached = true;
}

function stopRenderLoop() {
  if (!renderTickAttached) {
    return;
  }

  Ticker.shared.remove(renderTick);
  renderTickAttached = false;
}

// id полотна по его canvas — событие контекста приходит от конкретного
function canvasIdByTarget(target) {
  return Object.keys(renderContexts).find(
    id => renderContexts[id].app.canvas === target,
  );
}

// потеря WebGL-контекста (сворачивание вкладки, сброс GPU-драйвера): сцена и
// тикер целы, но все текстуры мертвы — полотно рисовалось бы пустым. Рендер
// снимаем до восстановления
function handleContextLost(event) {
  // без preventDefault браузер не пришлёт webglcontextrestored
  event.preventDefault();

  const id = canvasIdByTarget(event.target);

  if (id === undefined || !contextTracker.markLost(id)) {
    return;
  }

  stopRenderLoop();
  console.warn(`[render] WebGL context lost (${id}), rendering paused`);
}

// восстановление контекста: перепекаем ассеты и пересобираем карту (весь
// видимый контент — RenderTexture без CPU-источника). Танки и динамика
// восстановятся сами из ближайших кадров
function handleContextRestored(event) {
  const id = canvasIdByTarget(event.target);

  // пересобираем сцену только когда живы ВСЕ контексты: перепечка в ещё
  // мёртвый контекст даёт пустые текстуры, а второго события не будет
  if (id === undefined || !contextTracker.markRestored(id)) {
    return;
  }

  // сущности держат мёртвые текстуры
  for (const p in CTRL) {
    if (Object.hasOwn(CTRL, p)) {
      CTRL[p].remove();
    }
  }

  for (const id in renderContexts) {
    if (Object.hasOwn(renderContexts, id)) {
      const { app, assetProvider, bakingArr } = renderContexts[id];

      // BakingProvider пишет в тот же экземпляр Map, который держит
      // GameModel._assets — контроллеры пересоздавать не нужно
      if (bakingArr) {
        assetProvider.bakeAll(bakingArr, app);
      }
    }
  }

  if (lastMapData) {
    applyMapData(lastMapData, { notifyHost: false });
  }

  startRenderLoop();
  console.warn('[render] WebGL context restored, rendering resumed');
}

// ДАННЫЕ ОТ ХОСТА (WebRTC-транспорт)

// обрабатывает входящий пакет: ArrayBuffer → кадр снапшота, строка → JSON-порт
function handleMessage(data) {
  // бинарный кадр (snapshot, порт SHOT_DATA) — в ядро: распаковка, вставка
  // в буфер по seq, reconciliation предикта по player-блоку
  if (data instanceof ArrayBuffer) {
    // бета помнит seq последнего кадра хоста (seqFloor, этап 6) — до
    // push_frame: ядро может забрать буфер
    standbyReceiver?.noteFrame(data);
    // восстановленный матч пошёл — сторожок тишины снимает фору
    supervisor?.noteFrame();
    clientCore?.push_frame(new Uint8Array(data), performance.now());

    return;
  }

  // JSON-сообщение [portId, payload]; порт без обработчика игнорируется, а
  // не роняет обработку (lib/socketDispatch.js)
  dispatchSocketMessage(socketMethods, unpacking(data));
}

// терминальное закрытие сессии (супервизор: возвращаться некуда — кик,
// политика, уход хоста, окно переподключения истекло). Останавливаем
// рендер, показываем заглушку и возвращаемся в лобби перезагрузкой.
// closeCode приходит только от WebSocket-транспорта (dedicated), остальные
// транспорты эмитят close без него
function handleDisconnect(closeCode) {
  showSessionOverlay(null);

  // app.stop() здесь не зовём: при sharedTicker это Ticker.shared.stop()
  // глобально, а autoStart вернёт тикер к жизни при первом add() из любого
  // part'а — уже без renderTick. Рендер снят строкой выше, страницу и так
  // убивает location.reload() через 3 с
  stopRenderLoop();

  // иначе восстановление контекста вернуло бы рендер уже мёртвой игре
  for (const id in renderContexts) {
    if (Object.hasOwn(renderContexts, id)) {
      const { canvas } = renderContexts[id].app;

      canvas.removeEventListener('webglcontextlost', handleContextLost);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored);
      delete renderContexts[id];
    }
  }

  contextTracker.reset();
  lastMapData = null;

  document.removeEventListener('visibilitychange', handleVisibilityChange);
  soundManager.destroy();
  modules.controls?.disableKeys();

  // гость выбыл из матча (кик уводит на главную без перезагрузки — сессия
  // сигналинга жива): снять членство, иначе вкладка «призраком» числится в
  // комнате. Best-effort; хост комнату так не покидает — его снимает мастер
  if (isLobbyMode && currentRoomId && !hostController) {
    signaling.leaveRoom(currentRoomId);
  }

  // если мы были хостом — гасим комнату: heartbeat, WebRTC-пиры, Worker
  cancelPromotion();
  teardownHostRole();
  teardownStandby();
  currentRoomId = null;
  memberJoined = false;
  joinRetry?.stop();
  clearTimeout(tokenCapsTimer);
  tokenCapsTimer = null;
  refreshRoomControls();

  // solo: хост крутится в этом же потоке — его таймеры переживут матч
  inlineHost?.destroy();
  inlineHost = null;

  // запасной текст политического отказа: если сервер прислал причину сам
  // (TECH_INFORM перед закрытием — так приезжает 4006, полная комната), ниже
  // не пишется вообще ничего, и побеждает серверный текст
  const policyInform = POLICY_CLOSE_INFORMS[closeCode];

  // терминальную причину закрытия (кик, полная комната) не затираем
  if (!terminalInformShown) {
    socketMethods[PS_TECH_INFORM_DATA](
      policyInform ??
        (isLobbyMode
          ? 'Host left — the room is closed. Finding another room…'
          : 'The match is over — connection to the host is closed.'),
    );
  }

  // в solo перезагружаться некуда: лобби нет, а матч поднимается с нуля.
  // В dedicated сервер жив — переподключение перезагрузкой уместно, но не
  // тогда, когда он сам нас и отбил по политике (network/policyClose.js)
  if (bootMode === 'solo' || !shouldReloadAfterClose(closeCode)) {
    return;
  }

  if (!isLobbyMode) {
    setTimeout(() => reloadPage(), 3000);

    return;
  }

  roomMenu?.setLink(null);

  // лобби-режим (host-migration, этап 3): кик и несостоявшийся старт комнаты
  // — на главную без перезагрузки (причина остаётся в #tech-informer, клик
  // по нему открывает лобби); закрытие комнаты — в быструю игру той же игры
  const exit = decideExitRoute({
    kicked: isKickClose(closeCode, terminalTechKey) || roomStartFailed,
    gameId: activeGameManifest?.id,
  });

  if (exit.reload === undefined) {
    setRoute(exit.route);
    techInformer.addEventListener('click', () => reloadPage(), {
      once: true,
    });

    return;
  }

  setTimeout(() => reloadPage(exit.reload), 3000);
}

/**
 * Внешний останов матча (standalone SDK, Этап 3 плана standalone-sdk).
 * Закрытие транспорта эмитит 'close' → handleDisconnect: тот снимает
 * рендер-луп, гасит inline-хост и освобождает звук/клавиатуру. Отдельного
 * teardown у SDK нет специально — путь останова один на все режимы.
 */
export function stopGame() {
  supervisor?.close();
}

// ***** супервизор сессии (host-migration этап 4) ***** //

// берёт транспорт под надзор. reconnect — фабрика попыток переподключения
// (только гость в лобби); без неё любое закрытие терминально, как раньше
function startSession(transport, reconnect = null) {
  supervisor = new SessionSupervisor({
    onMessage: handleMessage,
    onTerminal: handleDisconnect,
    onStateChange: handleSessionState,
    onResumed: handleSessionResumed,
    onResumeRejected: handleResumeRejected,
    onHostLost: reportHostUnreachable,
    onColdRestart: handleColdRestart,
    // кик (TECH_INFORM перед закрытием) и отказы политики не лечатся
    // переподключением
    isTerminalClose: closeCode =>
      terminalInformShown || !shouldReloadAfterClose(closeCode),
    reconnect,
    timing: lobbyConfig.session,
  });

  supervisor.attach(transport);
}

// оверлей сессии: text — показать с текстом, null — скрыть
function showSessionOverlay(text) {
  if (!sessionOverlay) {
    return;
  }

  if (text) {
    sessionOverlayText.textContent = text;
    sessionOverlay.style.display = 'flex';
  } else {
    sessionOverlayText.textContent = '';
    sessionOverlay.style.display = 'none';
  }
}

// сессия на паузе: транспорта к хосту нет, мир стоит
function isSessionPaused() {
  return (
    supervisor?.state === SESSION_STATES.reconnecting ||
    supervisor?.state === SESSION_STATES.migrating
  );
}

// пауза переподключения или смены хоста: мир стоит, ввод и звук выключены
// (зацикленные звуки не должны гудеть одной нотой всю паузу). Рендер не
// останавливается — кадр стоит, независимые от снапшотов анимации идут
function handleSessionState(state, prev) {
  if (state === SESSION_STATES.migrating) {
    showSessionOverlay('Switching host…');
    modules.controls?.disableKeys();
    soundManager.mute();
  } else if (state === SESSION_STATES.reconnecting) {
    // после смены хоста оверлей тот же до конца возобновления
    if (prev !== SESSION_STATES.migrating) {
      showSessionOverlay('Reconnecting…');
    }

    modules.controls?.disableKeys();
    soundManager.mute();
  } else if (state === SESSION_STATES.inGame) {
    showSessionOverlay(null);
  }
}

// транспорт к хосту оборвался в матче: мастер узнаёт об этом от гостя
// раньше, чем сам (host-migration этап 7.2) — проба хоста или его смена.
// Эпоха — хоста, к которому был транспорт: чужую мастер отбросит
function reportHostUnreachable() {
  if (isLobbyMode && currentRoomId && roomEpoch !== null && !hostController) {
    signaling.hostUnreachable(currentRoomId, roomEpoch);
  }
}

// новый хост поднял матч заново (cold): возобновлять нечего — чистый вход в
// ту же комнату с полным рукопожатием
function handleColdRestart() {
  reloadToRoom();
}

// место возвращено: предсказание начинается с чистого листа (вводы,
// ушедшие в оборванный транспорт, хост не получит никогда — переигрывать
// их нельзя), голосование хоста паузу не пережило. Дальше хост шлёт пакет
// входа: CLEAR, полный кадр, набор клавиш, SESSION_DATA
function handleSessionResumed() {
  clientCore?.reset();
  // «Change host?» ведёт мастер — оно паузу переживает
  modules.vote?.removeHostVotes();
  modules.controls?.enableKeys();

  if (document.visibilityState !== 'hidden') {
    soundManager.unmute();
  }
}

// место потеряно (ожидание истекло, ключ не принят): чистый вход в ту же
// комнату с полным рукопожатием
function handleResumeRejected(reason) {
  console.warn(`[session] resume rejected: ${reason}`);
  showSessionOverlay(null);
  reloadToRoom();
}

// ссылка на текущую комнату (иначе — на быструю игру той же игры)
function reloadToRoom() {
  const gameId = activeGameManifest?.id;

  if (!gameId) {
    reloadPage('');
    return;
  }

  reloadPage(
    currentRoomId
      ? formatRoomLink(gameId, currentRoomId)
      : formatGameLink(gameId),
  );
}

// хост начал рукопожатие заново посреди живой сессии (порт — какой
// именно). Второе ядро/Application не строим: в лобби — чистый вход в ту же
// комнату, в остальных режимах только журнал
function handleProtocolError(port) {
  diagnostics.warn('engine.session.protocol', { port }, { source: 'client' });

  if (isLobbyMode) {
    reloadToRoom();
  }
}

// БУТСТРАП: лобби и установка P2P через мастер-сервер

let lobby = null;

// ресурсы роли хоста (комната в этой же вкладке)
let hostController = null;
let hostConnections = null;
let hostHeartbeat = null;
// { roomId, epoch, roomSecret } из host_registered — с ними реконнект
// сигналинга возвращает ту же комнату (reclaim_host)
let hostRoom = null;

// id вкладки — ключ участника комнаты на мастере; живёт в памяти (не в
// storage): две вкладки одного профиля — два участника
const memberId = isLobbyMode ? crypto.randomUUID() : null;

// комната, в которой вкладка гость или хост (лобби-режим)
let currentRoomId = null;
// вкладка объявила мастеру членство (join_room) и повторяет его после
// реконнекта сигналинга — даже если WebRTC в этот момент переподключается
let memberJoined = false;
// повтор join_room, пока хост не вернул комнату рестартовавшему мастеру
const joinRetry = isLobbyMode
  ? new JoinRetry({
      send: () => sendJoinRoom(),
      windowMs: lobbyConfig.session.joinRetryWindowMs,
    })
  : null;
// вкладка ушла из лобби в комнату (по ссылке или из лобби). Не сбрасывается:
// после разрыва страница — остатки матча, и новый маршрут из hashchange
// поднимается перезагрузкой, а не бутстрапом поверх них
let roomEntered = false;
// Worker комнаты не поднялся: та же быстрая игра создала бы её снова и
// снова — поэтому уход на главную, как при кике
let roomStartFailed = false;

// меню комнаты внутри матча (этапы 3 и 8d) и защита вкладки хоста от
// случайного закрытия (этап 8.4): только лобби-режим
let roomMenu = null;
let unloadGuard = null;
// любая программная перезагрузка — только через неё (client/lib/pageReload.js)
const reloadPage = createPageReload({ getGuard: () => unloadGuard });
// бета, назначенная мастером комнате этой вкладки-хоста (successor_assigned)
let hostSuccessorMemberId = null;

if (isLobbyMode) {
  const roomMenuModel = new RoomMenuModel();

  roomMenu = new RoomMenuCtrl(
    roomMenuModel,
    new RoomMenuView(roomMenuModel, lobbyConfig.roomMenu),
    {
      onLeave: () => leaveServerByUser(),
      onHandover: () => startPlannedHandoff({ reason: 'handover', stay: true }),
    },
  );

  unloadGuard = new HostUnloadGuard({
    // мастер начинает аварийную миграцию сразу, не дожидаясь обрыва WS
    onHostLeave: () => {
      if (hostRoom) {
        signaling.hostLeaving(hostRoom.roomId, hostRoom.epoch);
      }
    },
    // место освобождается сразу, а не через resumeGraceMs
    onGuestLeave: () => announceGuestLeave(),
  });
}

// роль вкладки в комнате для меню и защиты закрытия: хост — пока у неё
// Worker комнаты (и во время промоушена), гость — пока она в комнате
function refreshRoomControls() {
  const role = !currentRoomId ? null : hostController ? 'host' : 'guest';
  const othersPresent =
    role === 'host' && (hostConnections?.peerCount ?? 0) > 0;

  roomMenu?.setRole({
    role,
    othersPresent,
    hasSuccessor: role === 'host' && hostSuccessorMemberId !== null,
  });
  unloadGuard?.update({ role, othersPresent });
}

// адресная строка показывает ссылку на комнату, пока вкладка в ней: её
// можно скопировать прямо оттуда, как и пунктом меню комнаты
function showRoomLink(gameId, roomId) {
  if (!gameId) {
    return;
  }

  const link = formatRoomLink(gameId, roomId);

  setRoute(link);
  roomMenu?.setLink(absoluteLink(link));
  refreshRoomControls();
}
// оффер ушёл, каналы ещё не открыты: unknownRoom в этот момент —
// комнаты нет
function offerPending() {
  const transport = supervisor?.transport;

  return transport instanceof WebRtcManager && !transport.isOpen;
}

// ***** преемник хоста (host-migration этап 6) ***** //

// может ли вкладка вообще хостить: проба модульного Worker'а не бесплатна —
// считается один раз, лениво
let canHostCached = null;
// тип своего ICE-кандидата в выбранной паре с хостом комнаты
let roomIceType = null;

// хост: канал standby к бете и поток контрольных точек
let standbySender = null;

// хост: сводка здоровья матча за эпизод скрытой вкладки (этап 9a)
let hiddenHealthLog = null;
// host_health мастеру (этап 9c; лобби-режим): правило сетевого лага
let hostHealthReporter = null;
// room_peers мастеру: кто подключён к хосту по WebRTC (счётчик лобби и
// кандидаты в беты — только они)
let roomPeersReporter = null;
// средний FPS рендера гостя за интервал отчёта (этап 9c); null — неизвестен
const fpsMeter = new FpsMeter();
let guestFps = null;

document.addEventListener('visibilitychange', () => {
  const hidden = document.visibilityState === 'hidden';

  hiddenHealthLog?.setHidden(hidden);
  hostHealthPolicy?.setHidden(hidden);

  // кадры скрытой вкладки (их нет) не тянут средний FPS вниз
  if (!hidden) {
    fpsMeter.reset();
  }
});

// закрытие скрытой вкладки: эпизод закрывается сводкой сейчас — журнал свой
// pagehide уже отработал (подписан раньше), поэтому отправка явная
window.addEventListener('pagehide', () => {
  if (hiddenHealthLog) {
    hiddenHealthLog.flush();
    diagnostics.flush();
  }
});

// бета: назначение мастера ({ roomId, epoch, game }), приём точек, прогретый
// Worker и периодический standby_status
let standbyRole = null;
let standbyReceiver = null;
let hostPrewarm = null;
let standbyStatusTimer = null;
let standbyReceived = 0;

// момент, когда вход станет слишком коротким для роли хоста: caps
// пересылаются мастеру, и он пересматривает бету
let tokenCapsTimer = null;
// хост: проактивная передача роли перед истечением входа (повторяется,
// пока не начнётся или вход не истечёт)
let tokenHandoff = null;

// возможности вкладки для мастера (выбор беты, master/successor.js); у
// хоста iceType не про него — он сам конец всех пар
// членство гостя в комнате на мастере (вход, реконнект сигналинга, повтор)
function sendJoinRoom() {
  memberJoined = true;
  armTokenCapsTimer();
  signaling.joinRoom({
    roomId: currentRoomId,
    memberId,
    token: lobbyAuthModel.getToken(),
    caps: memberCaps(),
  });
}

// хватит ли срока входа на роль хоста: register_host/reclaim_host
// предъявляют токен мастеру посреди матча, а продления нет
function tokenAllowsHostRole() {
  return tokenAllowsHosting(
    lobbyAuthModel.getTokenExpiresAt(),
    lobbyConfig.migration.minTokenLifetimeMs,
  );
}

function memberCaps() {
  canHostCached ??= canHostIn();

  return buildHostCaps({
    canHost: canHostCached && tokenAllowsHostRole(),
    iceType: hostController ? null : roomIceType,
    // средний FPS рендера гостя (этап 9c): мастер не назначает бетой
    // слабую вкладку
    fps: hostController ? null : guestFps,
  });
}

// возможности изменились (вкладка спрятана, сменился тип кандидата) —
// мастер пересматривает бету
function sendMemberUpdate() {
  if (isLobbyMode && currentRoomId) {
    signaling.memberUpdate(currentRoomId, memberCaps());
  }
}

// canHost гаснет по времени, а не по событию — без таймера мастер держал бы
// бетой вкладку, которая откажется от промоушена
function armTokenCapsTimer() {
  clearTimeout(tokenCapsTimer);
  tokenCapsTimer = null;

  const expiresAt = lobbyAuthModel.getTokenExpiresAt();

  if (!currentRoomId || expiresAt === null) {
    return;
  }

  const delay =
    expiresAt - lobbyConfig.migration.minTokenLifetimeMs - Date.now();

  if (delay > 0) {
    tokenCapsTimer = setTimeout(() => {
      tokenCapsTimer = null;
      sendMemberUpdate();
    }, delay);
  }
}

// хост с истекающим входом не вернёт комнату reclaim_host после моргания
// сигналинга — роль заранее уходит бете
function armTokenHandoffTimer() {
  tokenHandoff ??= new TokenHandoffTimer({
    getExpiresAt: () => lobbyAuthModel.getTokenExpiresAt(),
    leadMs: lobbyConfig.migration.tokenHandoffLeadMs,
    retryMs: lobbyConfig.migration.tokenHandoffRetryMs,
    tryStart: () =>
      Boolean(hostController) &&
      hostSuccessorMemberId !== null &&
      startPlannedHandoff({ reason: 'handover', stay: true, defer: true }),
  });
  tokenHandoff.arm();
}

function ensureStandbyReceiver() {
  if (!standbyReceiver) {
    standbyReceiver = new StandbyReceiver();
    standbyReceiver.publisher.on('checkpoint', onStandbyCheckpoint);
  }

  return standbyReceiver;
}

// полная точка собрана: мастеру — что она есть, Worker'у — прогрев
function onStandbyCheckpoint(checkpoint) {
  standbyReceived += 1;

  if (isDevBuild) {
    debugLog('standby received', {
      count: standbyReceived,
      bytes: checkpoint.bytes.byteLength,
      checkpointId: checkpoint.checkpointId,
    });
  }

  startStandbyDuties();
}

// канал мог открыться раньше, чем пришло standby_assigned: обязанности
// беты начинаются, когда есть и назначение, и точка
function startStandbyDuties() {
  const latest = standbyReceiver?.latest();

  if (!standbyRole || !latest) {
    return;
  }

  if (standbyStatusTimer === null) {
    reportStandbyStatus();
    standbyStatusTimer = setInterval(
      reportStandbyStatus,
      lobbyConfig.migration.standbyStatusIntervalMs,
    );
  }

  hostPrewarm ??= new HostPrewarm({
    prepareRoom: prepareHostRoom,
    diagnostics,
    onReady: prepared => {
      if (isDevBuild) {
        debugLog('standby worker prewarmed', prepared.gameRef);
      }
    },
    onError: error => console.warn('[standby] prewarm failed:', error),
  });
  hostPrewarm.warm(latest, { allowedGame: standbyRole.game });
}

function reportStandbyStatus() {
  const latest = standbyReceiver?.latest();

  if (standbyRole && latest) {
    signaling.standbyStatus({
      roomId: standbyRole.roomId,
      epoch: standbyRole.epoch,
      checkpointId: latest.checkpointId,
      createdAt: latest.createdAt,
      // мастер судит о свежести по возрасту точки, а не по приходу статуса
      ageMs: Math.max(0, Date.now() - latest.receivedAt),
    });
  }
}

// standby_released, уход из комнаты, смена эпохи: прогретый Worker
// гасится, точки выбрасываются
function teardownStandby() {
  clearInterval(standbyStatusTimer);
  standbyStatusTimer = null;
  standbyReceiver?.destroy();
  standbyReceiver = null;
  hostPrewarm?.destroy();
  hostPrewarm = null;
  standbyRole = null;
  standbyReceived = 0;
}

// подписки сигналинга роли преемника (лобби-режим)
function bindStandbySignaling() {
  // хост: к кому открыть канал standby
  signaling.publisher.on('successor_assigned', msg => {
    if (standbySender && msg.roomId === hostRoom?.roomId) {
      hostSuccessorMemberId = msg.successorMemberId ?? null;
      standbySender.setSuccessor(hostSuccessorMemberId);
      hostHealthPolicy?.setSuccessor(hostSuccessorMemberId !== null);
      refreshRoomControls();

      // в окне передачи по сроку входа бета появилась — передать сразу
      if (hostSuccessorMemberId !== null) {
        armTokenHandoffTimer();
      }
    }
  });

  // гость: мастер назначил его бетой
  signaling.publisher.on('standby_assigned', msg => {
    if (hostController || msg.roomId !== currentRoomId) {
      return;
    }

    if (standbyRole && standbyRole.epoch !== msg.epoch) {
      teardownStandby();
    }

    // game — игра комнаты по данным мастера: прогрев сверяет с ней точку
    standbyRole = {
      roomId: msg.roomId,
      epoch: msg.epoch,
      game: msg.game ?? null,
    };
    ensureStandbyReceiver();
    startStandbyDuties();
  });

  signaling.publisher.on('standby_released', msg => {
    if (msg.roomId === currentRoomId) {
      teardownStandby();
    }
  });

  document.addEventListener('visibilitychange', sendMemberUpdate);

  // свежий средний FPS гостя мастеру (этап 9c); хост его не шлёт
  Ticker.shared.add(() => fpsMeter.frame());
  setInterval(() => {
    guestFps = fpsMeter.sample();

    if (!hostController) {
      sendMemberUpdate();
    }
  }, lobbyConfig.migration.auto.fpsReportIntervalMs);
}

// solo: авторитетный хост в главном потоке (без Worker'а)
let inlineHost = null;

if (isDevBuild) {
  window.__vimpDebug = createDebugApi({
    getHostController: () => hostController,
    getClientCore: () => clientCore,
    reportUrl: lobbyConfig.debugReportUrl,
    startHandoff: startPlannedHandoff,
  });

  debugLog(
    'window.__vimpDebug is available: dump, startRecording, stopRecording, divergence',
  );
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

// устанавливает P2P-соединение с текущим хостом комнаты и уходит из лобби
function connectToRoom(roomId) {
  if (!ensureWebRtcAvailable()) {
    return;
  }

  currentRoomId = roomId;
  roomEntered = true;
  showRoomLink(activeGameManifest?.id, roomId);

  // первая попытка — обычный вход с рукопожатием, следующие (после обрыва
  // в матче) — переподключение с resume к текущему хосту той же комнаты
  startSession(openRoomTransport(roomId), guestReconnect());

  lobby?.close();
}

// попытки переподключения гостя: resume к текущему хосту комнаты
function guestReconnect() {
  return {
    createTransport: () => openRoomTransport(currentRoomId, { resume: true }),
    getToken: () => lobbyAuthModel.getToken(),
  };
}

// эпоха хоста комнаты, ответившего последним: ответы прежних эпох чужие
let roomEpoch = null;

// WebRTC-попытка к текущему хосту комнаты (мастер резолвит roomId)
function openRoomTransport(roomId, { resume = false } = {}) {
  const transport = new WebRtcManager(signaling, {
    iceServers: signaling.iceServers,
    memberId,
    resume,
    minEpoch: roomEpoch,
    connectTimeoutMs: lobbyConfig.webrtc.connectTimeoutMs,
    offerRetryMs: lobbyConfig.webrtc.offerRetryMs,
  });

  transport.publisher.on('open', () => {
    roomEpoch = transport.epoch ?? roomEpoch;
  });
  // тип ICE-кандидата — мастеру: по нему он выбирает бету (этап 6)
  transport.publisher.on('iceType', type => {
    roomIceType = type;
    sendMemberUpdate();
  });
  // канал standby открывает хост только назначенной бете
  transport.publisher.on('standby', channel =>
    ensureStandbyReceiver().attach(channel),
  );
  transport.connect(roomId).catch(() => transport.close());

  return transport;
}

// подготовка комнаты к Worker'у хоста: room.game по манифесту игры, карты
// мастера, URL worker-бандла. Общая для создания комнаты и прогрева
// преемника (host-migration этап 6, HostPrewarm). gameRef — манифест игры
// или { id, version } из контрольной точки: бета обязана поднять ту версию
// игры, что крутится в комнате (версионные URL мастера)
async function prepareHostRoom(room, gameRef = activeGameManifest) {
  const gameManifest = await resolveGameManifest(gameRef);

  // отладочный контур (этап 6): рекордер живого матча и хостовый CONSOLE-лог
  // поднимаются только в dev-сборке
  room.isDevMode = isDevBuild;

  // Этап 6.4: Worker грузит HostPlugin динамически по entries.host/entries.wasm
  // активной игры — движок больше не знает игру статически
  room.game = {
    id: gameManifest.id,
    version: gameManifest.version,
    hostEntryUrl: gameManifest.entries.host,
    wasmUrl: gameManifest.entries.wasm,
  };

  // Этап 5.1: комната стартует на актуальных картах мастера;
  // недоступность каталога некритична — Worker возьмёт карты из бандла
  let mapsVersion = null;

  try {
    const catalog = await fetchMasterMaps(gameManifest);

    room.maps = catalog.maps;
    mapsVersion = catalog.version;
  } catch (e) {
    console.warn('[maps] master catalog unavailable, using bundled maps:', e);
  }

  // Этап 5.2: Worker создаётся по манифесту мастера — бандл страницы после
  // деплоя исчезает из раздачи; без манифеста (dev) — бандловый URL,
  // обновления кода отключены
  let workerUrl = null;
  let codeVersion = null;

  try {
    const manifest = await fetchWorkerManifest();

    // составной codeVersion (Этап 6.5): движок (worker-бандл) + игра
    // (id/version манифеста, с которым комната стартует)
    codeVersion = {
      engine: manifest.version,
      game: { id: gameManifest.id, version: gameManifest.version },
    };
    workerUrl = manifest.url;
  } catch (e) {
    console.warn('[worker] master manifest unavailable, using bundled:', e);
  }

  return { room, workerUrl, mapsVersion, codeVersion };
}

// манифест игры по ссылке на неё: уже загруженный активный — как есть,
// другая версия — версионный манифест мастера
async function resolveGameManifest(gameRef) {
  if (gameRef?.entries) {
    return gameRef;
  }

  if (
    activeGameManifest &&
    gameRef.id === activeGameManifest.id &&
    gameRef.version === activeGameManifest.version
  ) {
    return activeGameManifest;
  }

  return fetchGamePluginManifest(
    lobbyConfig.game.versionManifestUrl(gameRef.id, gameRef.version),
  );
}

// поднимает комнату в этой же вкладке (Worker хоста): хост-игрок играет через
// loopback, удалённые клиенты — по WebRTC (answerer). Клиентский код одинаков,
// отличается лишь транспорт. promotion — отложенный холодный промоушен
// (host-migration этап 7.4): вместо новой комнаты — занять существующую
async function connectAsHost(room, { promotion = null } = {}) {
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

  roomEntered = true;

  const prepared = await prepareHostRoom(room);

  const controller = new HostController(room, {
    workerUrl: prepared.workerUrl,
    diagnostics,
    onReady: readyMsg => {
      // seed мира приезжает в 'ready' (этап 1): без него запись матча
      // невоспроизводима, поэтому он виден в консоли сразу
      if (isDevBuild) {
        debugLog('room ready', {
          map: readyMsg?.mapName,
          seed: readyMsg?.seed,
        });
      }

      startHostRegistration(readyMsg?.lobbyInfo ?? null);
    },

    onLobbyInfoChange: handleHostLobbyInfo,

    // Worker не поднялся (WASM/конфиг): гасим комнату и возвращаемся в лобби
    onError: msg => {
      // холодный преемник не справился — мастер возьмёт следующего
      if (hostPromotion) {
        signaling.promoteFailed(hostPromotion.promotion);
        hostPromotion = null;
      }

      roomStartFailed = true;
      handleDisconnect();
      socketMethods[PS_TECH_INFORM_DATA](
        `Failed to start the room: ${msg.message || 'unknown error'}. Click to return to the lobby.`,
      );
    },
  });

  adoptHostRole(controller, room, prepared, {
    promotion: promotion ? { mode: 'cold', promotion } : null,
  });

  // хост-игрок в этой же вкладке (socketId согласован с kick-исключением)
  // свой клиент хоста на loopback не рвётся: супервизор для него сквозной
  const transport = new LoopbackTransport(
    controller,
    lobbyConfig.create.hostSocketId,
  );

  startSession(transport);
  transport.connect();

  lobby?.close();
}

// ***** роль хоста (общая для создания комнаты и промоушена, этап 7.4) ***** //

// настройки комнаты, которую хостит вкладка (поля register_host)
let hostRoomConfig = null;
// строка карточки комнаты в лобби (из 'ready'; далее — lobby_info Worker'а):
// её задаёт игра (gameConfig.lobbyInfo), null — показывать нечего
let hostLobbyInfo = null;
// промоушен, ждущий host_registered: { mode: 'checkpoint'|'cold',
// promotion: { roomId, epoch, promotionToken } }
let hostPromotion = null;
// промоушен из контрольной точки, Worker которого ещё поднимается
let promotionInFlight = null;

/**
 * Вкладка становится хостом для готового (или поднимающегося) Worker'а:
 * приём офферов, поток контрольных точек бете, регистрация у мастера.
 * Обработчики сигналинга роли — в bindHostSignaling (подписаны один раз).
 * @param {HostController} controller
 * @param {Object} room - настройки комнаты (room.game — манифест игры).
 * @param {Object} prepared - prepareHostRoom: { mapsVersion, codeVersion }.
 * @param {Object} [options]
 * @param {Object|null} [options.promotion] - { mode, promotion, reason } —
 *   занять комнату преемником (reason — причина передачи из promote).
 */
function adoptHostRole(controller, room, prepared, { promotion = null } = {}) {
  hostMapsVersion = prepared.mapsVersion;
  hostCodeVersion = prepared.codeVersion;
  hostController = controller;
  hostRoomConfig = room;
  hostLobbyInfo = null;
  hostPromotion = promotion;
  hostRoom = null;
  // хост — участник своей комнаты через register_host, не join_room
  memberJoined = false;
  joinRetry?.stop();
  armTokenCapsTimer();
  armTokenHandoffTimer();

  diagnostics.setContext({ role: 'host' });

  // удалённые клиенты по WebRTC
  hostConnections = new HostConnectionManager(signaling, controller, {
    iceServers: signaling.iceServers,
    // бета могла подключиться позже назначения или переподключиться; число
    // людей в комнате — меню и защите закрытия
    onPeersChange: () => {
      standbySender?.refresh();
      roomPeersReporter?.notify();
      refreshRoomControls();
    },
  });
  roomPeersReporter = new RoomPeersReporter({
    send: report => signaling.roomPeers(report),
    getRoom: () => hostRoom,
    getMemberIds: () => hostConnections?.connectedMemberIds() ?? [],
    intervalMs: lobbyConfig.migration.peersReportIntervalMs,
  });

  // преемник (host-migration этап 6): канал standby к бете, назначенной
  // мастером, и поток контрольных точек по нему
  standbySender = new StandbySender({
    controller,
    connections: hostConnections,
    intervalMs: lobbyConfig.migration.checkpointIntervalMs,
    chunkBytes: lobbyConfig.migration.standbyChunkBytes,
    highWaterBytes: lobbyConfig.migration.standbyHighWaterBytes,
    reopenDelayMs: lobbyConfig.migration.standbyReopenDelayMs,
    reopenMaxDelayMs: lobbyConfig.migration.standbyReopenMaxDelayMs,
    diagnostics,
    onStats: isDevBuild ? stats => debugLog('standby sent', stats) : null,
  });

  // метрики здоровья Worker'а (этап 9a): скрытая вкладка троттлит цикл —
  // насколько, уходит в журнал одной сводкой за эпизод
  hiddenHealthLog = new HiddenHostHealthLog({
    warn: (code, summary) =>
      diagnostics.warn(code, summary, { source: 'client' }),
    hidden: document.visibilityState === 'hidden',
  });
  hostHealthReporter = isLobbyMode
    ? new HostHealthReporter({
        send: report => signaling.hostHealth(report),
        getRoom: () => hostRoom,
        intervalMs: lobbyConfig.migration.auto.hostHealthIntervalMs,
      })
    : null;
  controller.onHealth(health => {
    hiddenHealthLog?.add(health);
    hostHealthPolicy?.addHealth(health);
    hostHealthReporter?.add(health);
  });
  hostHealthPolicy?.setHost(true);
}

// Worker готов: регистрация комнаты у мастера и heartbeat
function startHostRegistration(lobbyInfo) {
  hostLobbyInfo = lobbyInfo;

  // периодический heartbeat/актуализация карточки у мастера; число
  // игроков мастер считает по участникам комнаты сам
  const update = () => signaling.updateHost({ info: hostLobbyInfo });

  // регистрация комнаты; при reconnect сигналинга — возврат той же
  // комнаты (reclaim_host), а fresh=true — новая комната, когда вернуть
  // прежнюю нельзя (её id занят или секрет не принят). Преемник до
  // host_registered занимает комнату promotionToken'ом
  hostRegistration = ({ fresh = false } = {}) => {
    const room = hostRoomConfig;
    const fields = {
      gameId: room.game.id,
      gameVersion: room.game.version,
      maxPlayers: room.maxPlayers,
      info: hostLobbyInfo,
      token: lobbyAuthModel.getToken(),
      memberId,
      caps: memberCaps(),
      // для холодного перезапуска комнаты преемником (этап 7.6)
      settings: sanitizeRoomSettings(room),
    };

    if (hostPromotion) {
      signaling.registerHost({ ...fields, promotion: hostPromotion.promotion });
    } else if (hostRoom && !fresh) {
      signaling.reclaimHost({ ...fields, ...hostRoom });
    } else {
      hostRoom = null;
      signaling.registerHost(fields);
    }

    clearInterval(hostHeartbeat);
    hostHeartbeat = setInterval(update, lobbyConfig.create.heartbeatInterval);
  };

  hostRegistration();
}

// строка карточки сменилась (карта, опция игры) — сразу отразить в лобби
// мастера
function handleHostLobbyInfo(info) {
  hostLobbyInfo = info;

  if (hostRegistration) {
    signaling.updateHost({ info });
  }
}

// снимает роль хоста: heartbeat, WebRTC-пиры, поток точек, Worker
function teardownHostRole() {
  plannedHandoff?.abort();
  tokenHandoff?.cancel();
  clearInterval(hostHeartbeat);
  hostHeartbeat = null;
  standbySender?.destroy();
  standbySender = null;
  hiddenHealthLog?.flush();
  hiddenHealthLog = null;
  hostHealthReporter = null;
  roomPeersReporter?.destroy();
  roomPeersReporter = null;
  hostHealthPolicy?.setHost(false);
  hostConnections?.destroy();
  hostConnections = null;
  hostController?.destroy();
  hostController = null;
  diagnostics.setContext({ role: 'client' });
  hostRegistration = null;
  hostRoom = null;
  hostRoomConfig = null;
  hostPromotion = null;
  hostSuccessorMemberId = null;
  roomMenu?.setHandoff(null);
  refreshRoomControls();
}

// подписки сигналинга роли хоста (лобби-режим, один раз на страницу: роль
// может прийти и уйти несколько раз — создание, промоушен, host_revoked)
function bindHostSignaling() {
  // мастер отвечает актуальными версиями каталога карт и worker-бандла:
  // расхождение (деплой, пока комната жила) — подтянуть каталог к следующей
  // смене карты / заменить Worker эстафетой на границе раунда (Этап 5.2)
  signaling.publisher.on('host_registered', msg => {
    if (!hostController) {
      return; // комната уже погашена
    }

    hostRoom = {
      roomId: msg.roomId,
      epoch: msg.epoch,
      roomSecret: msg.roomSecret,
    };
    currentRoomId = msg.roomId;
    roomEpoch = msg.epoch;
    showRoomLink(hostRoomConfig.game.id, msg.roomId);

    // roomId + секрет эпохи не известны Worker'у до этого момента —
    // прокидываем их, чтобы PlayerDataSync атрибутировал последующие
    // rank/state-flush к этой комнате (секрет доказывает мастеру владение)
    hostController.setRoom(hostRoom);
    // мастер (новый или после рестарта) узнаёт подключённых сразу
    roomPeersReporter?.refresh();

    if (hostPromotion) {
      const promotion = hostPromotion;

      hostPromotion = null;
      finishPromotion(promotion);
    }

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

  // проба мастера (host-migration этап 7.3): гости жалуются, что хост
  // недоступен — главный поток подтверждает, что жив. Отвечает сразу, без
  // Worker'а: проба проверяет вкладку и её сигналинг, не матч
  signaling.publisher.on('probe', msg => {
    if (hostController && msg.roomId === hostRoom?.roomId) {
      signaling.probeAck(msg.nonce);
    }
  });

  // сигнал мастера об обновлении каталога карт/кода (hot-reload в будущем)
  signaling.publisher.on('update_available', msg => {
    if (!hostController) {
      return;
    }

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

  // мастер повысил эту вкладку до хоста комнаты (host-migration этап 7.4)
  signaling.publisher.on('promote', handlePromote);

  // промоушен отменён (опоздали к дедлайну): матч гасится, вкладка снова
  // гость и ждёт нового хоста
  signaling.publisher.on('promote_cancelled', msg => {
    if (msg.roomId !== currentRoomId) {
      return;
    }

    cancelPromotion();
    // сорвавшаяся плановая передача: её финальная точка следующую не завершит
    standbyReceiver?.discardFinal();

    if (hostPromotion) {
      abandonPromotion();
    }
  });

  // хоста сменили, пока эта вкладка была без связи (host-migration этап 7.5)
  signaling.publisher.on('host_revoked', msg => {
    if (hostController && msg.roomId === hostRoom?.roomId) {
      demoteHost(msg.epoch);
    }
  });

  plannedHandoff = new PlannedHandoff({
    signaling,
    getRoom: () => hostRoom,
    getController: () => hostController,
    slowAfterMs: lobbyConfig.migration.handoffSlowMs,
    deadlineMs: lobbyConfig.migration.handoffDeadlineMs,
    deferMaxMs: lobbyConfig.migration.deferMaxMs,
    onSlow: () => roomMenu?.setHandoff('slow'),
    onFrozen: handleHandoffFrozen,
    onReleased: handleHostReleased,
    onAborted: handleHandoffAborted,
    onLeave: () => leaveServer(),
  });

  // автотриггеры передачи (этап 9b): перегрузка и скрытая вкладка
  hostHealthPolicy = new HostHealthPolicy({
    config: lobbyConfig.migration.auto,
    handoff: {
      start: ({ reason, defer }) =>
        startPlannedHandoff({ reason, stay: true, defer }),
      hurry: reason => plannedHandoff.hurry(reason),
      // нагрузка нормализовалась до границы раунда — передача не нужна
      cancelDeferred: () => {
        const cancelled = plannedHandoff.cancelDeferred();

        if (cancelled) {
          roomMenu?.setHandoff(null);
        }

        return cancelled;
      },
      deferredReason: () =>
        plannedHandoff.deferred ? plannedHandoff.reason : null,
    },
  });
  hostHealthPolicy.setHidden(document.visibilityState === 'hidden');

  // мастер просит отдать роль: сеть хоста заметно хуже, чем у беты (этап
  // 9c). Передача ждёт границы раунда; выключенные автотриггеры — отказ
  signaling.publisher.on('request_handoff', msg => {
    // хоста сняли голосованием (этап 10): передача сразу, при любых
    // настройках автотриггеров — иначе мастер снимет его аварийно
    if (
      msg.reason === 'vote' &&
      hostController &&
      msg.roomId === hostRoom?.roomId &&
      msg.epoch === hostRoom.epoch
    ) {
      // передача уже ждёт границы раунда — сразу, с причиной vote; уже
      // идущая — её исход решит мастер
      if (!plannedHandoff?.hurry('vote')) {
        startPlannedHandoff({ reason: 'vote', stay: true, defer: false });
      }

      return;
    }

    if (
      msg.reason === 'network' &&
      lobbyConfig.migration.auto.enabled !== false &&
      hostController &&
      msg.roomId === hostRoom?.roomId &&
      msg.epoch === hostRoom.epoch
    ) {
      startPlannedHandoff({
        reason: 'network',
        stay: true,
        defer: msg.defer !== false,
      });
    }
  });

  // роль отдана, а передачи эта вкладка уже не ждёт (ответ мастера опоздал
  // к дедлайну): бета заняла комнату — свой игрок возвращается к ней гостем
  signaling.publisher.on('host_released', msg => {
    if (
      !plannedHandoff.active &&
      hostController &&
      msg.roomId === hostRoom?.roomId
    ) {
      handleHostReleased({ stay: true, epoch: msg.epoch });
    }
  });
}

// ***** плановая передача хоста (host-migration этап 8.2) ***** //

let plannedHandoff = null;
// автотриггеры передачи (этап 9b; лобби-режим)
let hostHealthPolicy = null;

/**
 * Отдать роль хоста бете без отката: «Leave server» (stay: false — затем в
 * лобби), «Hand over host» (stay: true — дальше гостем). Повторный вызов во
 * время идущей передачи игнорируется.
 *
 * defer (по умолчанию — для stay): передача ждёт границы раунда, если игра
 * не умеет продолжать посреди него (без migration.midRound мягкая точка
 * начала бы раунд у беты заново); решает Worker, потолок —
 * lobby.migration.deferMaxMs. Уходящий хост не ждёт.
 * @param {Object} options
 * @param {string} options.reason - 'leave' | 'handover' | 'overload' |
 *   'hidden' | 'network' | 'vote'.
 * @param {boolean} [options.stay]
 * @param {boolean} [options.defer]
 * @returns {boolean} передача началась.
 */
function startPlannedHandoff({ reason, stay = true, defer = stay }) {
  // промоушен сам владеет Worker'ом
  if (!plannedHandoff || !hostController || hostPromotion) {
    return false;
  }

  // эстафета, ждущая границы раунда, уступает передаче: преемник и так
  // поднимется на актуальном коде. Своп, уже переносящий состояние, — нет
  if (workerSwapInProgress && !hostController.cancelPendingSwap()) {
    return false;
  }

  const started = plannedHandoff.start({ reason, stay, defer });

  if (started) {
    roomMenu?.setHandoff('pending');
  }

  return started;
}

// матч заморожен до прихода нового хоста — у своего игрока та же пауза,
// что у гостей
function handleHandoffFrozen() {
  showSessionOverlay('Switching host…');
  modules.controls?.disableKeys();
  soundManager.mute();
}

// передача не состоялась, вкладка осталась хостом: замороженный матч
// продолжается (Worker разморожен, гостям ушла полная синхронизация)
function handleHandoffAborted({ reason, frozen }) {
  console.warn(`[handoff] not completed: ${reason}`);
  roomMenu?.setHandoff('failed');

  const { hideOverlay, restoreInput } = controlsAfterAbort({
    frozen,
    sessionState: supervisor?.state ?? null,
  });

  if (hideOverlay) {
    showSessionOverlay(null);
  }

  // вкладка осталась хостом: эстафета, вытесненная передачей, нужна снова
  if (hostCodeVersion) {
    refreshHostWorker();
  }

  // передача по сроку входа всё ещё нужна
  tokenHandoff?.retry();

  if (!restoreInput) {
    return;
  }

  modules.controls?.enableKeys();

  if (document.visibilityState !== 'hidden') {
    soundManager.unmute();
  }
}

// бета заняла комнату с того же тика: Worker этой вкладки больше не нужен
function handleHostReleased({ stay, epoch }) {
  if (!stay) {
    leaveServer();
    return;
  }

  demoteHost(epoch, { notice: false });

  // возобновление идёт под тем же оверлеем, что и пауза передачи
  if (supervisor?.state === SESSION_STATES.reconnecting) {
    showSessionOverlay('Switching host…');
  }
}

// «Leave server» из меню комнаты (этап 8.3). Хост при других людях отдаёт
// роль бете без отката и уходит; один в комнате — закрывает её
// (host_leaving: людей нет — мастер закрывает комнату сразу). Гость
// снимается у хоста сразу (LEAVE), а не через resumeGraceMs
// уход уже идёт (ожидание записи очков): повторный клик ничего не делает
let leavingServer = false;

async function leaveServerByUser() {
  if (leavingServer) {
    return;
  }

  if (hostController) {
    const peerCount = hostConnections?.peerCount ?? 0;

    if (
      peerCount > 0 &&
      startPlannedHandoff({ reason: 'leave', stay: false })
    ) {
      return;
    }

    // передавать некому: очки участников иначе пропали бы вместе с
    // Worker'ом. Пока они пишутся, мастер прячет комнату и не пускает в
    // неё (host_closing) — вошедший сразу вылетел бы по закрытию
    if (peerCount === 0) {
      leavingServer = true;
      showSessionOverlay('Leaving…');

      if (hostRoom) {
        signaling.hostClosing(hostRoom.roomId, hostRoom.epoch);
      }

      try {
        await hostController.shutdown({
          timeoutMs: lobbyConfig.migration.leaveFlushTimeoutMs,
        });
      } catch (e) {
        console.warn('host shutdown failed', e);
      }
    }

    // передача уже идёт (эстафета Worker'ов, промоушен) или передавать
    // некому: уход по аварийному пути мастера
    if (hostRoom) {
      signaling.hostLeaving(hostRoom.roomId, hostRoom.epoch);
    }
  } else {
    sending(PC_LEAVE);
  }

  leaveServer();
}

// гость уходит: LEAVE хосту и leave_room мастеру (best-effort — страница
// может закрыться раньше, чем пакеты уйдут)
function announceGuestLeave() {
  sending(PC_LEAVE);

  if (currentRoomId) {
    signaling.leaveRoom(currentRoomId);
  }
}

// уход из комнаты в лобби (не быструю игру — она вернула бы в эту же
// комнату). Мастер освобождает место сразу; бывшему хосту leave_room
// принимается после host_released (сессия уже не хост). Уход объявлен —
// диалог закрытия и pagehide снимает reloadPage
function leaveServer() {
  if (currentRoomId) {
    signaling.leaveRoom(currentRoomId);
  }

  memberJoined = false;
  joinRetry?.stop();

  teardownHostRole();
  teardownStandby();
  reloadPage('');
}

// ***** промоушен преемника (host-migration этап 7.4) ***** //

function handlePromote(msg) {
  // повтор promote нашей плановой передачи режимом checkpoint: хост пропал
  // посреди неё — финальную точку больше не ждём
  if (
    promotionInFlight &&
    msg.mode === 'checkpoint' &&
    promotionInFlight.degrade(msg)
  ) {
    return;
  }

  if (
    !currentRoomId ||
    msg.roomId !== currentRoomId ||
    hostController ||
    promotionInFlight
  ) {
    return;
  }

  // вход истечёт посреди хостинга — отказ сразу, мастер возьмёт следующего
  if (!tokenAllowsHostRole()) {
    signaling.promoteFailed(msg);
    return;
  }

  const gameId = activeGameManifest?.id;

  // cold: точки нет — свежий матч той же комнаты после перезагрузки (бутстрап
  // видит отложенный промоушен и занимает комнату вместо создания новой)
  if (msg.mode === 'cold') {
    let storage = null;

    try {
      storage = window.sessionStorage;
    } catch {
      storage = null;
    }

    if (!gameId || !savePendingPromotion(storage, msg, gameId)) {
      signaling.promoteFailed(msg);
      return;
    }

    reloadPage(formatRoomLink(gameId, msg.roomId));

    return;
  }

  const promotion = new Promotion({
    promote: msg,
    receiver: standbyReceiver,
    finalWaitMs: lobbyConfig.migration.finalWaitMs,
    maxRestoreAgeMs: lobbyConfig.migration.maxRestoreAgeMs,
    prewarm: hostPrewarm,
    prepareRoom: prepareHostRoom,
    hostSocketId: lobbyConfig.create.hostSocketId,
    diagnostics,
    hostCallbacks: { onLobbyInfoChange: handleHostLobbyInfo },
    hasSession: () => supervisor?.hasSession === true,
    // host_migrating, если и придёт следом (старый мастер), migrate() уже
    // не исполнит — транспорт с каналом standby останется цел
    holdSession: () => supervisor?.migrate({ keepTransport: true }),
    onReady: ({ controller, room, prepared, lobbyInfo }) => {
      promotionInFlight = null;
      adoptHostRole(controller, room, prepared, {
        promotion: {
          mode: 'checkpoint',
          promotion: promotion.promotion,
          reason: msg.reason ?? null,
        },
      });
      startHostRegistration(lobbyInfo);
    },
    onFailed: error => {
      promotionInFlight = null;
      console.warn('[promotion] failed:', error);
      signaling.promoteFailed(promotion.promotion);
    },
  });

  promotionInFlight = promotion;
  promotion.start();
}

// промоушен из точки ещё поднимает Worker — бросить его
function cancelPromotion() {
  promotionInFlight?.cancel();
  promotionInFlight = null;
}

// занять комнату не вышло (мастер отверг регистрацию или отменил
// промоушен): роль снимается. report — сообщить мастеру, чтобы он взял
// следующего кандидата, не дожидаясь дедлайна
function abandonPromotion({ code = null, report = false } = {}) {
  const { mode, promotion } = hostPromotion;

  if (code) {
    console.warn(`[promotion] register rejected: ${code}`);
  }

  if (report) {
    signaling.promoteFailed(promotion);
  }

  teardownHostRole();

  // cold: страница — свежий хост без матча; гостем — чистым входом в ту же
  // комнату (отложенный промоушен уже снят). checkpoint: супервизор так и
  // ждёт нового хоста (migrating)
  if (mode === 'cold') {
    reloadToRoom();
  }
}

// комната занята: матч стартует, когда вернутся люди точки (или по
// resumeWaitMs), свой игрок возвращается в него через loopback
function finishPromotion({ mode, reason = null }) {
  teardownStandby();

  if (mode !== 'checkpoint') {
    return;
  }

  hostController.startAfterRestore({ waitForResume: true, reason });

  const transport = new LoopbackTransport(
    hostController,
    lobbyConfig.create.hostSocketId,
    { resume: true },
  );

  transport.connect();

  // свой Worker: другой попытки, кроме loopback, нет — как у хоста
  // комнаты с создания. Комната уже занята этой вкладкой и гости
  // переключены на неё: сбой своего игрока её не гасит
  supervisor?.resumeWith(transport, {
    reconnect: null,
    getToken: () => lobbyAuthModel.getToken(),
    onFailed: handleOwnPlayerLost,
  });
}

// свой игрок преемника не вернулся в поднятый им матч (секрета нет, отказ
// RESUME, loopback закрыт): роль хоста остаётся — Worker, пиры, heartbeat
// и поток точек живут, гости играют. Перезагрузка убила бы матч всех
function handleOwnPlayerLost(reason) {
  console.warn(`[promotion] own player not restored: ${reason}`);
  showSessionOverlay(null);
  modules.controls?.disableKeys();
  soundManager.mute();
  socketMethods[PS_TECH_INFORM_DATA](
    'Your player could not be restored — the room keeps running for the others.',
  );
}

// ***** бывший хост (host-migration этап 7.5) ***** //

// хоста сменили (host_revoked или staleEpoch на reclaim) или он отдал роль
// сам (host_released, notice: false): матч этой вкладки гасится, свой игрок
// возвращается гостем к новому хосту под своим gameId (его место есть в
// точке беты). minEpoch — эпоха нового хоста или нижняя граница
function demoteHost(minEpoch, { notice = true } = {}) {
  // хост уходил из комнаты, а роль сменилась без него — уходит всё равно
  if (plannedHandoff?.leaving) {
    leaveServer();
    return;
  }

  teardownHostRole();
  teardownStandby();
  roomEpoch = minEpoch;

  if (notice) {
    modules.chat?.add(buildSystemMessage('HOST_REVOKED'));
  }

  if (!currentRoomId) {
    reloadPage('');
    return;
  }

  sendJoinRoom();

  const reconnect = guestReconnect();

  if (
    !supervisor?.resumeWith(
      openRoomTransport(currentRoomId, { resume: true }),
      { reconnect },
    )
  ) {
    reloadToRoom();
  }
}

// solo-режим: авторитетный матч в этом же потоке (standalone SDK). Ни
// мастера, ни Worker'а, ни WebRTC — только inline-хост и loopback
async function connectSolo() {
  const socketId = lobbyConfig.create.hostSocketId;

  inlineHost = new InlineHostBridge(
    {
      name: 'solo',
      ...boot.room,
      hostSocketId: socketId,
      // hostEntryUrl не нужен: HostPlugin приходит живым объектом
      game: {
        id: activeGameManifest.id,
        version: activeGameManifest.version,
        wasmUrl: activeGameManifest.entries.wasm,
      },
    },
    { hostPlugin: boot.hostPlugin },
  );

  // хендшейк начинается в connect() — хост к этому моменту обязан быть готов
  await inlineHost.ready;

  const transport = new LoopbackTransport(inlineHost, socketId);

  startSession(transport);
  transport.connect();
}

// dedicated-режим: прямой WebSocket к Node-серверу игры
function connectDedicated() {
  const transport = new WebSocketTransport(boot.wsUrl);

  startSession(transport);
  transport.connect();
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
async function fetchMasterMaps(gameManifest = activeGameManifest) {
  const manifestRes = await fetch(lobbyConfig.maps.manifestUrl(gameManifest));

  if (!manifestRes.ok) {
    throw new Error(`maps manifest: HTTP ${manifestRes.status}`);
  }

  const manifest = await manifestRes.json();

  const entries = await Promise.all(
    manifest.maps.map(async name => {
      const url = `${lobbyConfig.maps.baseUrl(gameManifest)}/${encodeURIComponent(name)}`;
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
  if (workerSwapInProgress || !hostController || plannedHandoff?.active) {
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
    // эстафету вытеснила плановая передача хоста — версия не сломана:
    // сорвётся передача — handleHandoffAborted запустит своп снова
    if (e.message === 'swap preempted') {
      console.info('[worker] swap preempted by planned host handoff');
      return;
    }

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

  // токен едет и сюда (master-game-registry, этап 4): список серверов
  // публичный, но админу мастер отдаёт вместе с ним скрытые тестовые
  // комнаты застейдженных версий
  const token = lobbyAuthModel?.getToken();

  try {
    const res = await fetch(
      `${lobbyConfig.serversUrl}?${params}`,
      token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
    );

    return res.ok ? await res.json() : null;
  } catch (e) {
    return null;
  }
}

// топ-N рейтинга игры (lobby-page-plan) — публичный эндпоинт, доступен и до
// логина, поэтому без Authorization.
//
// Зовётся только ЛОББИ. Из матча за топом ходит хост комнаты и раздаёт его
// портом ACCOLADES_DATA (host/meta/modules/Accolades.js): 80 000 игроков,
// спрашивающих мастер лично, и 10 000 комнат, спрашивающих за них, — разные
// порядки величин. Там же живёт и If-None-Match: валидатор имеет смысл
// рядом с повторяющимся запросом, а лобби открывают по одному разу
async function fetchLeaderboard(gameId, period) {
  const params = new URLSearchParams({
    game: gameId,
    limit: lobbyConfig.leaderboardLimit,
    // rank-periods: срез времени. Мастер отвечает 400 на незнакомый —
    // значение всегда из lobbyConfig.leaderboardPeriods
    period,
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
async function fetchPlacement(gameId, period) {
  const token = lobbyAuthModel?.getToken();

  if (!token) {
    return null;
  }

  try {
    const res = await fetch(
      // тот же срез, что и у списка рядом: плашка позиции, посчитанная за
      // всё время под заголовком «сегодня», противоречила бы списку
      `${lobbyConfig.placementUrl}?${new URLSearchParams({ game: gameId, period })}`,
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
// дескрипторы той же формы (после mergeRoomDefaults) — нужны отдельно для
// валидации (bindLiveErrors по ходу правки и при сабмите)
let roomFormDescriptors = [];

// генерирует форму создания комнаты по явной схеме манифеста (roomForm,
// docs/en/plugin-api.md "Form schema") — движок не выводит контролы из типа
// значения, схема плагина полностью описывает форму
function populateRoomForm(manifest) {
  const container = document.getElementById(lobbyConfig.elems.fieldsId);

  if (!container) {
    return;
  }

  if (Array.isArray(manifest.roomForm)) {
    roomFormDescriptors = mergeRoomDefaults(
      manifest.roomForm,
      manifest.roomDefaults,
    );

    roomFormFields = buildForm(roomFormDescriptors, container, {
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
    roomFormDescriptors = [];
  }
}

// каталог манифестов по id: форма и leaderboard селектора игр, а также
// активация игры перед созданием комнаты и входом в чужую
const gamesById = new Map(
  gamesManifest.map(manifest => [manifest.id, manifest]),
);

// ClientPlugin выбранной игры грузится в момент клика (создание комнаты /
// вход в комнату), а не при смене селектора: просмотр каталога не должен
// качать бандлы игр, в которые не станут играть
const activateGame = createGameActivator({ gamesById, loadClientPlugin });

// строка отказа в форме лобби: загрузка плагина восстановима (другая игра,
// повторный клик), поэтому #tech-informer не годится — он кроет вкладку
// непрозрачным слоем под терминальные причины
function showLobbyError(text) {
  const elem = document.getElementById(lobbyConfig.elems.errorId);

  if (elem) {
    elem.textContent = text;
  }
}

function clearLobbyError() {
  const elem = document.getElementById(lobbyConfig.elems.errorId);

  if (elem) {
    elem.textContent = '';
  }
}

// активирует игру и перепривязывает манифест/плагин/CSS; false — отказ уже
// показан игроку (report, по умолчанию строкой формы лобби), лобби остаётся
// рабочим
async function selectActiveGame(gameId, { report = showLobbyError } = {}) {
  // сверка идёт с самим манифестом, а не с его id: каталог вкладки может
  // пополниться застейдженной версией той же игры (registerGameManifest), и
  // сравнение по id оставило бы активной одобренную версию
  // activeGameManifest?. — каталог платформы может быть пуст: активной игры
  // у вкладки тогда нет вовсе, и первая же активация обязана состояться
  if (
    gameId === activeGameManifest?.id &&
    gamesById.get(gameId) === activeGameManifest
  ) {
    return true;
  }

  try {
    const { manifest, plugin } = await activateGame(gameId);

    bindActiveGame(manifest, plugin);
    clearLobbyError();

    return true;
  } catch (e) {
    console.error(`[game] failed to activate "${gameId}":`, e);
    report(
      `Failed to load ${gamesById.get(gameId)?.title ?? gameId}: ${e.message}`,
    );

    return false;
  }
}

// очередь активации черновиков (см. подписку на 'staged' в initLobby)
let stagedActivation = Promise.resolve();

// id игр, чей манифест в каталоге вкладки подменён застейдженной версией
// (master-game-registry, этап 4): в селекторе такая игра помечается, чтобы
// админ видел, что поднимет комнату НЕ на одобренной версии
const stagedGameIds = new Set();

/**
 * Кладёт манифест застейдженной (не одобренной) версии в каталог вкладки —
 * так админ может поднять по нему комнату, не трогая каталог игроков.
 * Дальше всё работает существующим путём: createGameActivator грузит
 * ClientPlugin по entries.client (ключ кеша версионный, поэтому плагин
 * черновика не подменит одобренный), connectAsHost поднимает комнату, а
 * мастер помечает её скрытой по версии манифеста.
 * @param {Object} manifest - Манифест застейдженной версии из /admin/games.
 * @returns {void}
 */
function registerGameManifest(manifest) {
  if (!manifest?.id) {
    return;
  }

  gamesById.set(manifest.id, manifest);
  stagedGameIds.add(manifest.id);
  populateGameSelect();
}

// заполняет #lobby-game всем каталогом манифестов мастера — раньше туда
// попадал только gamesManifest[0], теперь селектор рабочий.
// Источник — gamesById, а не gamesManifest: каталог вкладки пополняется на
// лету застейдженными версиями (registerGameManifest), и селектор
// перерисовывается целиком
function populateGameSelect() {
  const gameSelect = document.getElementById(lobbyConfig.elems.gameId);

  if (!gameSelect) {
    return;
  }

  // перерисовка не должна сбрасывать выбор игрока: селектор целиком
  // пересобирается и при добавлении застейдженной версии
  const selected = gameSelect.value;

  gameSelect.textContent = '';

  gamesById.forEach(manifest => {
    const option = document.createElement('option');
    const available = isGameAvailable(manifest);

    option.value = manifest.id;
    // недоступная игра остаётся видимой (раньше мастер выкидывал её из
    // каталога, и игрок видел пустое лобби без причины), но выбрать её
    // нельзя: комнату по ней всё равно не поднять
    option.textContent = available
      ? `${manifest.title}${stagedGameIds.has(manifest.id) ? lobbyConfig.games.stagedSuffix : ''}`
      : `${manifest.title} — unavailable`;
    option.disabled = !available;
    option.title = available ? '' : manifest.compat.text;
    gameSelect.appendChild(option);
  });

  if (selected && gamesById.has(selected)) {
    gameSelect.value = selected;
  } else if (activeGameManifest) {
    gameSelect.value = activeGameManifest.id;
  }
  // без активной игры выбор не трогаем: каталог был пуст, и селектор только
  // что получил первую строку — она и стоит выбранной по умолчанию.
  // Присваивание `''` вместо этого сняло бы выбор совсем (selectedIndex = -1)
}

// форма комнаты, Leaderboard и «Create server» по активной игре; пустой
// каталог — вторая законная ветка (client/lib/catalogState.js)
function syncCatalogState() {
  applyCatalogState(activeGameManifest, {
    hostBtn: document.getElementById(lobbyConfig.elems.hostBtnId),
    emptyText: catalogProblem ?? lobbyConfig.create.emptyCatalogText,
    bindGame: manifest => {
      populateRoomForm(manifest);
      lobby.gameChanged(manifest.id, manifest.title);
    },
    showError: showLobbyError,
    clearError: clearLobbyError,
  });
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

  // срезы рейтинга (rank-periods) — сразу после создания контроллера и до
  // первого gameChanged: тот уже несёт открытый срез в запросе
  lobby.setPeriods(
    lobbyConfig.leaderboardPeriods,
    lobbyConfig.defaultLeaderboardPeriod,
  );

  // список серверов — REST-запросом к мастеру
  lobbyModel.publisher.on('fetch', async query => {
    const list = await fetchServers(query);

    if (list) {
      lobbyModel.setList(list, query.append);
    }
  });

  // умный пинг видимого сервера — сигнальным путём (замер приблизительный)
  lobbyModel.publisher.on('ping-request', ({ roomId, pingId }) => {
    signaling.pingHost(roomId, pingId);
  });

  signaling.publisher.on('pong_host', msg => {
    lobbyModel.resolvePong(msg.pingId, performance.now());
  });

  // выбор сервера → активация игры комнаты и установка P2P. gameId нет у
  // хостов старше 6.4 — тогда заходим на активной игре, как раньше: неизвестная
  // версия не повод запретить вход
  lobbyModel.publisher.on('join', async ({ roomId, gameId }) => {
    if (gameId && gamesById.has(gameId)) {
      if (!(await selectActiveGame(gameId))) {
        return;
      }
    } else if (!activeGameManifest) {
      // комната пережила свою игру: её сняли с раздачи, пока комната шла, и
      // каталог вкладки пуст — заходить не на чем
      showLobbyError('This room runs a game that is no longer published');

      return;
    }

    connectToRoom(roomId);
  });

  // Leaderboard (lobby-page-plan): контроллер сигнализирует, для какой игры
  // нужны свежие данные (смена #lobby-game или первое открытие вкладки).
  // code review M1: сброс до fetch'а — иначе данные предыдущей игры видны
  // под заголовком новой, пока не пришёл ответ (и остаются навсегда при
  // сетевом сбое); reqId отбрасывает ответ устаревшего запроса, если игру
  // переключили быстрее, чем пришёл ответ (latest-wins)
  lobby.publisher.on('leaderboard-needed', async ({ gameId, period }) => {
    lobbyModel.clearLeaderboard();

    const reqId = ++leaderboardReqId;
    const [leaderboard, placement] = await Promise.all([
      fetchLeaderboard(gameId, period),
      fetchPlacement(gameId, period),
    ]);

    if (reqId !== leaderboardReqId) {
      return; // игру или срез уже переключили ещё раз — ответ устарел
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

  // ошибки формы видны по ходу правки (formBuilder.bindLiveErrors): до
  // первого клика по Create server — по тронутым полям, после — по всей форме
  const liveErrors = bindLiveErrors(
    document.getElementById(lobbyConfig.elems.fieldsId),
    document.getElementById(lobbyConfig.elems.errorId),
    () => ({ descriptors: roomFormDescriptors, fields: roomFormFields }),
  );

  // реестр игр (master-game-registry, этап 4): заявка разработчика и панель
  // модерации живут в том же лобби. Триплет поднимается вместе с лобби —
  // панель доступна любому авторизованному, кнопку модерации показывает роль
  const gamesModel = new GamesModel(lobbyConfig.games, () =>
    lobbyAuthModel.getToken(),
  );
  const gamesView = new GamesView(gamesModel, lobbyConfig.games);
  const games = new GamesCtrl(gamesModel, gamesView);

  // кнопку «Moderation» лобби показывает роли admin (master-game-registry,
  // этап 4). Это подсказка интерфейсу: доступ к данным проверяет мастер, а
  // запись — auth-сервис, перечитывая роль из БД
  games.setAdmin(lobbyAuthModel.getRole() === 'admin');

  // журнал клиентских ошибок (plan/client-reports, этап 5): кнопку «Errors»
  // видит только админ; фильтр по игре — каталог вкладки
  const clientReportsModel = new ClientReportsModel(
    lobbyConfig.clientReports,
    () => lobbyAuthModel.getToken(),
  );
  const clientReportsView = new ClientReportsView(
    clientReportsModel,
    lobbyConfig.clientReports,
  );
  const clientReports = new ClientReportsCtrl(
    clientReportsModel,
    clientReportsView,
  );

  clientReportsView.setGames([...gamesById.values()]);
  clientReports.setAdmin(lobbyAuthModel.getRole() === 'admin');

  // «Test»: манифест застейдженной версии кладётся в каталог вкладки, и
  // админ поднимает по нему комнату обычной кнопкой Create server
  games.publisher.on('staged', ({ manifest }) => {
    registerGameManifest(manifest);
    gamesView.hide();

    // каталог был пуст (первое развёртывание платформы либо снятая с раздачи
    // последняя игра): черновик — единственная игра вкладки, и создание
    // комнаты включается только после того, как её плагин привязан
    if (activeGameManifest) {
      return;
    }

    // строго по очереди: loadStaged() восстанавливает все черновики этого
    // мастера синхронным циклом, и без очереди два черновика при пустом
    // каталоге ушли бы активироваться одновременно — активной осталась бы
    // одна игра, а форма комнаты собралась бы по другой
    stagedActivation = stagedActivation
      .then(async () => {
        if (activeGameManifest) {
          return; // предыдущий черновик уже стал активным
        }

        // только на успехе: отказ активации уже написал в ту же строку СВОЮ
        // причину («Failed to load X: …»), и общее «игр пока не опубликовано»
        // затёрло бы её — админ увидел бы не то, что случилось
        if (await selectActiveGame(manifest.id)) {
          syncCatalogState();
        }
      })
      .catch(e => {
        // отказ не должен заклинить очередь: следующий черновик обязан
        // получить свой шанс стать активной игрой
        console.error('[game] staged activation failed:', e);
      });
  });

  // создание комнаты в этой же вкладке (хост-игрок через loopback)
  populateGameSelect();
  syncCatalogState();

  // селектор игр: меняет форму создания комнаты и Leaderboard сразу
  // (синхронно, без сети); сама игра активируется уже по клику
  const gameSelect = document.getElementById(lobbyConfig.elems.gameId);

  const hostBtn = document.getElementById(lobbyConfig.elems.hostBtnId);

  gameSelect?.addEventListener('change', () => {
    const manifest = gamesById.get(gameSelect.value);

    if (!manifest) {
      return;
    }

    populateRoomForm(manifest);
    lobby.gameChanged(manifest.id, manifest.title);
    // форма пересобрана: она снова ничья, а блок ошибок чистит сам disarm
    liveErrors.disarm();
  });

  hostBtn?.addEventListener('click', async () => {
    // валидация (pattern/required/min/max) — единственная граница
    // room-формы: она едет клиенту как JSON манифеста, JS-валидаторы
    // (как в auth-форме) туда не сериализуются (docs/en/plugin-api.md
    // "Form schema"); авторитетный клампинг всё равно в applyRoomOverrides.js
    // (вызывается из host.worker.js при создании комнаты). Проверяем до
    // активации игры: неверная форма не должна стоить загрузки плагина.
    // arm() и рисует ошибки, и снимает фильтр «только тронутые поля»: клик —
    // это ответ за форму целиком, включая поля, которых игрок не касался.
    // Он же чистит блок, когда ошибок нет
    if (liveErrors.arm().length) {
      return;
    }

    const manifest = gamesById.get(gameSelect?.value) ?? activeGameManifest;

    // значения формы снимаем до await: активация асинхронна, а roomFormFields
    // пересобираются при смене игры — в комнату должно уехать то, что игрок
    // видел в момент клика
    const overrides = { ...manifest.roomDefaults };

    for (const [key, field] of roomFormFields) {
      overrides[key] = field.getValue();
    }

    // повторный клик, пока грузится плагин, не должен поднять вторую комнату;
    // при успехе лобби закрывается, разблокировка нужна только на отказе
    hostBtn.disabled = true;

    if (!(await selectActiveGame(manifest.id))) {
      hostBtn.disabled = false;

      return;
    }

    connectAsHost({
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
let lobbyAuthModel = null;
let lobbyAuthView = null;

let welcomeReceived = false;
let authenticated = false;

// маршрут разбирается один раз: повторный welcome (реконнект сигналинга)
// бутстрап не повторяет
let routeBooted = false;

function maybeInitLobby() {
  if (welcomeReceived && authenticated && !routeBooted) {
    routeBooted = true;
    runRoute();
  }
}

// ПРЯМЫЕ ССЫЛКИ (host-migration, этап 3): без hash — лобби, #/<gameId> —
// быстрая игра, #/<gameId>/<roomId> — вход в комнату (client/lib/roomLink.js)

// комната по прямому id; null — её нет или мастер не ответил (тогда — быстрая
// игра той же игры, как для мёртвой ссылки)
async function fetchRoom(roomId) {
  return (await pollRoom(roomId)).info;
}

// GET /rooms/:roomId со статусом: ожиданию миграции важно отличить «комнаты
// нет» (404) от сбоя запроса. status null — запрос не дошёл
async function pollRoom(roomId) {
  try {
    const res = await fetch(lobbyConfig.roomUrl(roomId));

    return { status: res.status, info: res.ok ? await res.json() : null };
  } catch {
    return { status: null, info: null };
  }
}

// #tech-informer, который игрок закрывает кликом: причина отказа маршрута
// видна поверх лобби, но лобби остаётся рабочим
function showDismissibleInformer(text) {
  if (text) {
    socketMethods[PS_TECH_INFORM_DATA](text);
  }

  techInformer.addEventListener(
    'click',
    () => socketMethods[PS_TECH_INFORM_DATA](),
    { once: true },
  );
}

// лобби вместо маршрута: адрес — без hash (иначе F5 повторил бы маршрут),
// игра маршрута — выбрана в селекторе
function showLobby({ gameId, informer } = {}) {
  setRoute('');
  initLobby();

  const gameSelect = document.getElementById(lobbyConfig.elems.gameId);

  if (gameSelect && gameId && gamesById.has(gameId)) {
    gameSelect.value = gameId;
    gameSelect.dispatchEvent(new Event('change'));
  }

  if (informer) {
    showDismissibleInformer(informer);
  }
}

// дефолты формы создания комнаты — то, что ушло бы в комнату по Create без
// правки полей: roomDefaults манифеста + default'ы самой схемы формы
function roomDefaultsOf(manifest) {
  const defaults = { ...manifest.roomDefaults };

  if (Array.isArray(manifest.roomForm)) {
    for (const field of mergeRoomDefaults(
      manifest.roomForm,
      manifest.roomDefaults ?? {},
    )) {
      if (field.default !== undefined) {
        defaults[field.name] = field.default;
      }
    }
  }

  return defaults;
}

// активация игры маршрута: лобби ещё нет (строку формы, куда пишет
// selectActiveGame по умолчанию, initLobby тут же перетёр бы), поэтому
// отказ показывается поверх лобби в #tech-informer
async function activateRouteGame(gameId) {
  let failure = null;

  if (await selectActiveGame(gameId, { report: text => (failure = text) })) {
    return true;
  }

  showLobby({ gameId, informer: failure });

  return false;
}

// вход по маршруту — лобби не показывается вовсе: игрок сразу видит экран
// авторизации игры (AUTH_DATA → #auth)
async function joinFromRoute(gameId, roomId) {
  if (await activateRouteGame(gameId)) {
    connectToRoom(roomId);
  }
}

// самая наполненная неполная комната игры: её выбирает мастер; мастер без
// роута или сбой — выбор по полному списку, как раньше
async function findQuickPlayRoom(gameId) {
  try {
    const res = await fetch(lobbyConfig.quickPlayUrl(gameId));

    if (res.ok) {
      const { room } = await res.json();

      return room && typeof room.roomId === 'string' ? room : null;
    }
  } catch {
    // ниже — запасной путь
  }

  const list = await fetchServers({ search: gameId });

  return pickQuickPlayRoom(list?.servers, gameId);
}

// быстрая игра: самая наполненная неполная комната игры, иначе своя
async function quickPlay(gameId) {
  let room = await findQuickPlayRoom(gameId);

  // гости закрытой комнаты приходят сюда разом: случайная пауза и второй
  // взгляд на список — комнату создаст первый, остальные в неё войдут
  if (!room && lobbyConfig.quickPlay.autoCreate) {
    await wait(quickPlayCreateDelay(lobbyConfig.quickPlay));
    room = await findQuickPlayRoom(gameId);
  }

  if (room) {
    await joinFromRoute(gameId, room.roomId);

    return;
  }

  if (!lobbyConfig.quickPlay.autoCreate) {
    showLobby({ gameId });

    return;
  }

  const manifest = gamesById.get(gameId);

  if (!(await activateRouteGame(gameId))) {
    return;
  }

  await connectAsHost({
    hostSocketId: lobbyConfig.create.hostSocketId,
    ...roomDefaultsOf(manifest),
  });

  // браузер не может быть хостом (connectAsHost уже показал причину): лобби
  // под ней, войти в чужую комнату он всё ещё может
  if (!roomEntered) {
    showLobby({ gameId });
    showDismissibleInformer();
  }
}

// маршрут в работе (ждёт /rooms или /servers): hashchange в это время не
// запускает второй бутстрап — тот дошёл бы до connectToRoom/connectAsHost
// параллельно первому (два транспорта в одной вкладке). Новый hash
// разбирается после текущего, если вкладка так и не вошла в комнату
let routeRunning = false;
let routeRerun = false;

async function runRoute() {
  if (routeRunning) {
    routeRerun = true;

    return;
  }

  routeRunning = true;

  try {
    do {
      routeRerun = false;
      await bootRoute();
    } while (routeRerun && !roomEntered);
  } finally {
    routeRunning = false;
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ожидание брошено: hash сменился, маршрут разбирается заново
const ROUTE_ABANDONED = Symbol('routeAbandoned');

// комната по ссылке меняет хоста: ждём, пока она снова станет online.
// null — комната пропала или так и не дождались (тогда — быстрая игра);
// ROUTE_ABANDONED — игрок ушёл по другой ссылке (runRoute повторит разбор)
async function waitRoomOnline(roomId) {
  // крайний срок — с запасом на цепочку кандидатов (дедлайн каждого — у
  // мастера); 404 обрывает ожидание раньше
  const { linkWaitMaxMs, migrationPollMs } = lobbyConfig.session;
  const deadline = performance.now() + linkWaitMaxMs;

  socketMethods[PS_TECH_INFORM_DATA]('Switching host…');

  try {
    while (performance.now() < deadline) {
      await wait(migrationPollMs);

      if (routeRerun) {
        return ROUTE_ABANDONED;
      }

      const poll = await pollRoom(roomId);

      if (routeRerun) {
        return ROUTE_ABANDONED;
      }

      switch (classifyRoomPoll(poll)) {
        case 'online':
          return poll.info;
        case 'gone':
          return null;
      }
    }

    return null;
  } finally {
    socketMethods[PS_TECH_INFORM_DATA]();
  }
}

// холодный промоушен (host-migration этап 7.4): страница перезагружена в
// комнату, чтобы поднять её матч заново. Запись снимается при любом исходе
function takeRoutePromotion(route) {
  let storage = null;

  try {
    storage = window.sessionStorage;
  } catch {
    return null;
  }

  const pending = takePendingPromotion(storage);

  return pending &&
    route.kind === 'room' &&
    route.gameId === pending.gameId &&
    route.roomId === pending.roomId
    ? pending
    : null;
}

// занимает комнату холодным промоушеном. false — вкладка хостить не может,
// маршрут разбирается как обычный вход гостем
async function promoteCold(pending) {
  // вход истёк за время перезагрузки — комнату займёт другой кандидат
  if (!tokenAllowsHostRole()) {
    signaling.promoteFailed(pending);

    return false;
  }

  if (!(await activateRouteGame(pending.gameId))) {
    signaling.promoteFailed(pending);

    return true;
  }

  currentRoomId = pending.roomId;

  await connectAsHost(
    {
      hostSocketId: lobbyConfig.create.hostSocketId,
      ...roomDefaultsOf(gamesById.get(pending.gameId)),
      ...pending.settings,
    },
    { promotion: pending },
  );

  if (roomEntered) {
    return true;
  }

  currentRoomId = null;
  signaling.promoteFailed(pending);

  return false;
}

// разбор маршрута после логина и welcome (только лобби-режим)
async function bootRoute() {
  const route = parseRoute(location.hash);
  const pending = takeRoutePromotion(route);

  if (pending && (await promoteCold(pending))) {
    return;
  }

  let roomInfo = route.kind === 'room' ? await fetchRoom(route.roomId) : null;
  let decision = decideRouteAction(route, roomInfo, gamesById);

  if (decision.action === 'wait') {
    roomInfo = await waitRoomOnline(decision.roomId);

    if (roomInfo === ROUTE_ABANDONED) {
      return;
    }

    decision = decideRouteAction(route, roomInfo, gamesById);
  }

  switch (decision.action) {
    case 'join':
      await joinFromRoute(decision.gameId, decision.roomId);
      break;

    case 'quickPlay':
      await quickPlay(decision.gameId);
      break;

    default:
      if (route.kind === 'none') {
        initLobby();
      } else {
        showLobby({ informer: decision.informer });
      }
  }
}

// hashchange: вне комнаты — новый маршрут бутстрапом; в комнате — ссылка на
// неё же ничего не меняет, любой другой маршрут — перезагрузкой (матч не
// разбирается без неё). replaceState (setRoute) это событие не порождает
function handleHashChange() {
  if (!routeBooted) {
    return; // бутстрап ещё впереди и сам прочитает hash
  }

  if (!roomEntered) {
    runRoute();

    return;
  }

  const route = parseRoute(location.hash);

  if (route.kind === 'room' && route.roomId === currentRoomId) {
    return;
  }

  reloadPage(location.hash);
}

// сигнальный WS живёт постоянно и у хоста (офферы, heartbeat), и у гостя
// (членство в комнате): при разрыве переподключаемся с бэкоффом, а welcome
// возвращает комнату — хост reclaim_host'ом, гость повторным join_room с тем
// же memberId
function bindSignalingSession() {
  let reconnectAttempt = 0;

  signaling.publisher.on('close', () => {
    const { baseDelay, maxDelay } = lobbyConfig.reconnect;
    const delay = Math.min(maxDelay, baseDelay * 2 ** reconnectAttempt);

    reconnectAttempt += 1;
    setTimeout(() => signaling.connect(), delay);
  });

  signaling.publisher.on('welcome', () => {
    reconnectAttempt = 0;

    if (hostController) {
      hostRegistration?.();
    } else if (currentRoomId && memberJoined) {
      sendJoinRoom();
    }
  });

  // смена хоста комнаты (host-migration этап 7.2): старый транспорт
  // закрывается сразу, ждём host_changed. Хост этой вкладки сообщения не
  // получает (его ждёт host_revoked)
  signaling.publisher.on('host_migrating', msg => {
    if (
      !currentRoomId ||
      msg.roomId !== currentRoomId ||
      hostController ||
      (roomEpoch !== null && msg.epoch <= roomEpoch)
    ) {
      return;
    }

    // повтор той же эпохи — следующий кандидат: ждать дольше (waitMs)
    if (supervisor?.state === SESSION_STATES.migrating) {
      supervisor.extendMigration(msg.waitMs);
    } else {
      supervisor?.migrate({ waitMs: msg.waitMs });
    }
  });

  // у комнаты новый хост (или прежний вернулся — reclaimed, та же эпоха):
  // возобновление у него, cold — перезагрузка в комнату
  signaling.publisher.on('host_changed', msg => {
    if (
      !currentRoomId ||
      msg.roomId !== currentRoomId ||
      hostController ||
      (roomEpoch !== null && msg.epoch < roomEpoch)
    ) {
      return;
    }

    // ответы прежних эпох попыткам возобновления чужие
    roomEpoch = msg.epoch;
    supervisor?.hostChanged({ mode: msg.mode });
  });

  signaling.publisher.on('room_closed', msg => {
    if (!currentRoomId || msg.roomId !== currentRoomId) {
      return;
    }

    joinRetry?.stop();

    // быстрее, чем ждать падения WebRTC; причина важнее общего текста
    // handleDisconnect
    leaveRoomWith('The host left — the room is closed. Finding another room…');
  });

  // мастер принял членство — повторы join_room больше не нужны
  signaling.publisher.on('room_joined', msg => {
    if (msg.roomId === currentRoomId) {
      joinRetry?.stop();
    }
  });

  signaling.publisher.on('error', handleSignalingError);

  // голосование «Change host» (этап 10): окно у гостей, кроме инициатора;
  // хосту мастер его не шлёт
  signaling.publisher.on('host_vote', msg => {
    if (!currentRoomId || msg.roomId !== currentRoomId || hostController) {
      return;
    }

    hostVote = { roomId: msg.roomId, voteId: msg.voteId };
    modules.vote?.openEngineVote({
      name: CHANGE_HOST_VOTE,
      title: changeHostTitle(msg.initiatorNick),
      values: CHANGE_HOST_VALUES,
      // часы мастера и вкладки расходятся — окно считается от прихода
      deadline: Date.now() + msg.durationMs,
    });
  });

  // своё голосование началось — как у голосований хоста
  signaling.publisher.on('host_vote_started', msg => {
    if (currentRoomId && msg.roomId === currentRoomId) {
      modules.chat?.add(buildSystemMessage('VOTE_STARTED'));
    }
  });

  // свой ответ в окне «Change host?» засчитан — как у голосований хоста
  signaling.publisher.on('host_vote_accepted', msg => {
    if (currentRoomId && msg.roomId === currentRoomId) {
      modules.chat?.add(buildSystemMessage('VOTE_ACCEPTED'));
    }
  });

  signaling.publisher.on('host_vote_result', msg => {
    if (!currentRoomId || msg.roomId !== currentRoomId) {
      return;
    }

    if (hostVote?.voteId === msg.voteId) {
      hostVote = null;
      modules.vote?.closeEngineVote(CHANGE_HOST_VOTE);
    }

    const { key, params } = resultMessage(msg);

    modules.chat?.add(buildSystemMessage(key, params));
  });
}

// открытое у гостя голосование «Change host» ({ roomId, voteId }) — ответ
// окна уходит мастеру с этим voteId
let hostVote = null;

// показывает терминальную причину и возвращает в лобби (путь
// handleDisconnect: закрытие транспорта → перезагрузка)
function leaveRoomWith(message) {
  socketMethods[PS_TECH_INFORM_DATA](message);
  terminalInformShown = true;

  if (supervisor) {
    supervisor.close();
  } else {
    handleDisconnect();
  }
}

// отказы мастера на сигнальные сообщения
function handleSignalingError(msg = {}) {
  const { code, reason } = msg;

  switch (code) {
    // мастер не начал голосование «Change host» (этап 10)
    case 'voteRejected':
    case 'noSuccessor':
      modules.chat?.add(
        buildSystemMessage(rejectionMessageKey({ code, reason })),
      );
      break;

    // запрос ушёл в комнату, которой уже нет
    case 'unknownRoom': {
      const action = decideUnknownRoom({
        msg,
        currentRoomId,
        promoting: Boolean(hostPromotion),
        sessionState: supervisor?.state ?? null,
        offerPending: offerPending(),
        memberJoined,
        isHost: Boolean(hostController),
      });

      if (action === 'abandonPromotion') {
        abandonPromotion({ code, report: true });
      } else if (action === 'retryJoin') {
        joinRetry?.schedule();
      } else if (action === 'leave') {
        leaveRoomWith('Room no longer exists. Finding another room…');
      }
      break;
    }

    // memberId вкладки (randomUUID) занят другим пользователем — честная
    // вкладка сюда не попадает; только в журнал
    case 'memberTaken':
      console.warn('join_room rejected: memberTaken', msg.roomId);
      break;

    // токен истёк или отозван: решение — по запросу, на который отказ
    case 'invalidToken': {
      const action = decideInvalidToken({
        msg,
        promoting: Boolean(hostPromotion),
        inRoom: Boolean(currentRoomId),
        sessionState: supervisor?.state ?? null,
      });

      if (action === 'abandonPromotion') {
        abandonPromotion({ code, report: true });
      } else if (action === 'keepPlaying') {
        // P2P-матчу токен не нужен; без нового текста в UI (системные
        // сообщения — только кодами, тексты в играх)
        diagnostics.warn(
          'engine.session.tokenExpired',
          { re: msg.re },
          { source: 'client' },
        );
        joinRetry?.stop();
      } else {
        lobbyAuthModel.logout();

        if (action === 'logoutAndLeave') {
          leaveRoomWith('Your session has expired — please sign in again.');
        }
      }
      break;
    }

    // с этого адреса уже хостится другая комната
    case 'hostLimit':
      if (hostController) {
        // быстрая игра подняла бы комнату снова и упёрлась бы в тот же
        // лимит — уход на главную, как при несостоявшемся старте
        roomStartFailed = true;
        leaveRoomWith(
          'Another room is already hosted from your network — this room is ' +
            'closed. Click to return to the lobby.',
        );
      }
      break;

    // прежнюю комнату вернуть нельзя (id занят или секрет не принят — dev-
    // мастер без VIMP_ROOM_SECRET_KEY после рестарта): новая регистрация
    case 'roomTaken':
    case 'invalidRoomSecret':
      if (hostController) {
        hostRegistration?.({ fresh: true });
      }
      break;

    // хоста комнаты уже сменили (host-migration этап 7.5): преемник
    // опоздал — роль снимается; бывший хост вернулся после смены — он
    // гость новой эпохи
    case 'staleEpoch':
      if (hostPromotion) {
        abandonPromotion({ code, report: true });
      } else if (hostController && hostRoom) {
        demoteHost(hostRoom.epoch + 1);
      }
      break;

    // promotionToken не принят (промоушен отменён, кандидат сменился)
    case 'invalidPromotion':
      if (hostPromotion) {
        abandonPromotion({ code, report: true });
      }
      break;
  }
}

// точка 2 ветвления: лобби, OAuth-гейт и сигналинг живут только в lobby;
// solo и dedicated идут сразу к транспорту
if (isLobbyMode) {
  lobbyAuthModel = new LobbyAuthModel(authClientConfig);
  lobbyAuthView = new LobbyAuthView(lobbyAuthModel, authClientConfig);

  const lobbyAuthCtrl = new LobbyAuthCtrl(lobbyAuthModel, lobbyAuthView);

  signaling.publisher.on('welcome', () => {
    welcomeReceived = true;
    maybeInitLobby();
  });

  bindSignalingSession();
  bindStandbySignaling();
  bindHostSignaling();

  lobbyAuthModel.publisher.on('authenticated', () => {
    authenticated = true;
    maybeInitLobby();
    // новый вход — новый срок: canHost пересчитается по нему, передача роли
    // хоста — тоже
    armTokenCapsTimer();

    if (hostController) {
      armTokenHandoffTimer();
    }

    // повторный вход после logout: маршрут уже разобран, а логин-гейт
    // спрятал лобби — вернуть его, если вкладка не в комнате
    if (routeBooted && !roomEntered) {
      lobby?.open();
    }
  });

  // OAuth-возврат: токены из query прочитаны — чистим только query, hash
  // (маршрут #/<gameId>[/<roomId>]) остаётся
  if (lobbyAuthCtrl.init(window.location.search)) {
    window.history.replaceState(
      null,
      '',
      window.location.pathname + window.location.hash,
    );
  }

  window.addEventListener('hashchange', handleHashChange);

  signaling.connect();
} else if (bootMode === 'solo') {
  try {
    await connectSolo();
  } catch (e) {
    socketMethods[PS_TECH_INFORM_DATA](
      `Failed to start the match: ${e.message || 'unknown error'}`,
    );
    throw e;
  }
} else {
  connectDedicated();
}
