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
import engineChatMessages from '../config/chatMessages.js';
import { createDebugApi, debugLog, DEBUG_PREFIX } from './debug.js';
import { buildClientCoreConfig } from '../lib/clientCoreConfig.js';
import { buildSnapshotKeysById } from '../lib/reconstructHot.js';
import Factory from '../lib/factory.js';
import { formatMessage } from '../lib/formatters.js';
import { sanitizeMessage } from '../lib/sanitizers.js';
import { validateAuth } from '../lib/validators.js';
import SoundManager from './SoundManager.js';
import SignalingClient from './network/SignalingClient.js';
import LoopbackTransport from './network/LoopbackTransport.js';
import WebSocketTransport from './network/WebSocketTransport.js';
import InlineHostBridge from './network/InlineHostBridge.js';
import SessionSupervisor, {
  SESSION_STATES,
} from './network/SessionSupervisor.js';
import FpsMeter from './lib/FpsMeter.js';
import HostUnloadGuard from './lib/hostUnloadGuard.js';
import { createPageReload } from './lib/pageReload.js';
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
import { createRoomContext } from './session/roomContext.js';
import { createHostRoomPrep } from './session/hostRoomPrep.js';
import Membership from './session/Membership.js';
import StandbyRole from './session/StandbyRole.js';
import HostRole from './session/HostRole.js';
import HandoffFlow from './session/HandoffFlow.js';
import PromotionFlow from './session/PromotionFlow.js';
import GuestSession from './session/GuestSession.js';
import RouteBoot from './session/RouteBoot.js';
import ClientReportsModel from './components/model/ClientReports.js';
import ClientReportsView from './components/view/ClientReports.js';
import ClientReportsCtrl from './components/controller/ClientReports.js';
import RoomMenuModel from './components/model/RoomMenu.js';
import RoomMenuView from './components/view/RoomMenu.js';
import RoomMenuCtrl from './components/controller/RoomMenu.js';
import {
  absoluteLink,
  decideExitRoute,
  formatGameLink,
  formatRoomLink,
  setRoute,
} from './lib/roomLink.js';
import {
  CHANGE_HOST_VOTE,
  answerValue,
  parseChangeHost,
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
    if (roomCtx.roomId && !hostRole.controller) {
      membership.sendJoinRoom();
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
    defaultMessages: engineChatMessages,
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
  } else if (hostRole.controller) {
    notice('HOST_VOTE_IS_HOST');
  } else if (!signaling?.connected || !roomCtx.roomId) {
    notice('HOST_VOTE_OFFLINE');
  } else {
    signaling.hostVoteStart(roomCtx.roomId);
  }
}

// ответ в окне голосования: «Change host?» — мастеру, остальное — хосту
function handleVoteSend(data) {
  if (Array.isArray(data) && data[0] === CHANGE_HOST_VOTE) {
    const value = answerValue(data[1]);

    if (guest.hostVote && value && signaling?.connected) {
      signaling.hostVoteAnswer({ ...guest.hostVote, value });
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
    standby.noteFrame(data);
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
  if (isLobbyMode && roomCtx.roomId && !hostRole.controller) {
    signaling.leaveRoom(roomCtx.roomId);
  }

  // если мы были хостом — гасим комнату: heartbeat, WebRTC-пиры, Worker
  promotionFlow.cancel();
  hostRole.teardown();
  standby.teardown();
  roomCtx.roomId = null;
  membership.forget();
  membership.clearTokenCapsTimer();
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
    kicked: isKickClose(closeCode, terminalTechKey) || roomCtx.startFailed,
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
  if (isLobbyMode) {
    guest.reportHostUnreachable();
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
    roomCtx.roomId
      ? formatRoomLink(gameId, roomCtx.roomId)
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

// id вкладки — ключ участника комнаты на мастере; живёт в памяти (не в
// storage): две вкладки одного профиля — два участника
const memberId = isLobbyMode ? crypto.randomUUID() : null;

// меню комнаты внутри матча (этапы 3 и 8d) и защита вкладки хоста от
// случайного закрытия (этап 8.4): только лобби-режим
let roomMenu = null;
let unloadGuard = null;
// любая программная перезагрузка — только через неё (client/lib/pageReload.js)
const reloadPage = createPageReload({ getGuard: () => unloadGuard });

// ***** сценарии комнаты (client/session/*): здесь только сборка ***** //

const isPageHidden = () => document.visibilityState === 'hidden';
const informTech = text => socketMethods[PS_TECH_INFORM_DATA](text);
const chatNotice = message => modules.chat?.add(message);
const getSupervisor = () => supervisor;
const getToken = () => lobbyAuthModel.getToken();
const getTokenExpiresAt = () => lobbyAuthModel.getTokenExpiresAt();

// комната вкладки: id, эпоха хоста, членство, вход и несостоявшийся старт
const roomCtx = createRoomContext();

const hostRoomPrep = createHostRoomPrep({
  getActiveGame: () => activeGameManifest,
  config: lobbyConfig,
  isDevBuild,
  fetchGamePluginManifest,
});

const membership = new Membership({
  signaling,
  ctx: roomCtx,
  memberId,
  getToken,
  getTokenExpiresAt,
  isHost: () => Boolean(hostRole.controller),
  config: lobbyConfig,
});

const standby = new StandbyRole({
  signaling,
  ctx: roomCtx,
  isHost: () => Boolean(hostRole.controller),
  prepareRoom: hostRoomPrep.prepareHostRoom,
  diagnostics,
  config: lobbyConfig.migration,
  debug: isDevBuild ? debugLog : null,
});

const hostRole = new HostRole({
  signaling,
  ctx: roomCtx,
  membership,
  config: lobbyConfig,
  diagnostics,
  prep: hostRoomPrep,
  getActiveGame: () => activeGameManifest,
  getToken,
  getHandoff: () => handoff,
  onPromotionRegistered: hostPromotion => promotionFlow.finish(hostPromotion),
  isLobbyMode,
  debug: isDevBuild ? debugLog : null,
  ui: {
    showRoomLink,
    refreshRoomControls,
    setHandoffMenu: state => roomMenu?.setHandoff(state),
    isHidden: isPageHidden,
    informTech,
    ensureWebRtc: ensureWebRtcAvailable,
    startSession: transport => startSession(transport),
    closeLobby: () => lobby?.close(),
    // Worker не поднялся (WASM/конфиг): гасим комнату и возвращаемся в лобби
    onStartFailed: msg => {
      roomCtx.startFailed = true;
      handleDisconnect();
      informTech(
        `Failed to start the room: ${msg.message || 'unknown error'}. Click to return to the lobby.`,
      );
    },
  },
});

const handoff = new HandoffFlow({
  signaling,
  ctx: roomCtx,
  hostRole,
  standby,
  membership,
  getPromotion: () => promotionFlow,
  getSupervisor,
  getTokenExpiresAt,
  config: lobbyConfig.migration,
  ui: {
    showSessionOverlay,
    disableControls: () => modules.controls?.disableKeys(),
    enableControls: () => modules.controls?.enableKeys(),
    mute: () => soundManager.mute(),
    unmute: () => soundManager.unmute(),
    isHidden: isPageHidden,
    setHandoffMenu: state => roomMenu?.setHandoff(state),
    sendLeave: () => sending(PC_LEAVE),
    reloadPage,
  },
});

const guest = new GuestSession({
  signaling,
  ctx: roomCtx,
  membership,
  hostRole,
  standby,
  getPromotion: () => promotionFlow,
  getSupervisor,
  getToken,
  logout: () => lobbyAuthModel.logout(),
  config: lobbyConfig,
  diagnostics,
  ui: {
    ensureWebRtc: ensureWebRtcAvailable,
    showRoomLink: roomId => showRoomLink(activeGameManifest?.id, roomId),
    startSession,
    closeLobby: () => lobby?.close(),
    leaveRoomWith,
    chat: chatNotice,
    getVote: () => modules.vote,
  },
});

const promotionFlow = new PromotionFlow({
  signaling,
  ctx: roomCtx,
  hostRole,
  standby,
  membership,
  getHandoff: () => handoff,
  getGuest: () => guest,
  getSupervisor,
  getActiveGameId: () => activeGameManifest?.id,
  getToken,
  prepareRoom: hostRoomPrep.prepareHostRoom,
  config: lobbyConfig,
  diagnostics,
  ui: {
    reloadPage,
    reloadToRoom,
    showSessionOverlay,
    disableControls: () => modules.controls?.disableKeys(),
    mute: () => soundManager.mute(),
    informTech,
    chat: chatNotice,
  },
});

if (isLobbyMode) {
  const roomMenuModel = new RoomMenuModel();

  roomMenu = new RoomMenuCtrl(
    roomMenuModel,
    new RoomMenuView(roomMenuModel, lobbyConfig.roomMenu),
    {
      onLeave: () => handoff.leaveByUser(),
      onHandover: () => handoff.start({ reason: 'handover', stay: true }),
    },
  );

  unloadGuard = new HostUnloadGuard({
    // мастер начинает аварийную миграцию сразу, не дожидаясь обрыва WS
    onHostLeave: () => {
      if (hostRole.room) {
        signaling.hostLeaving(hostRole.room.roomId, hostRole.room.epoch);
      }
    },
    // место освобождается сразу, а не через resumeGraceMs
    onGuestLeave: () => handoff.announceGuestLeave(),
  });
}

// роль вкладки в комнате для меню и защиты закрытия: хост — пока у неё
// Worker комнаты (и во время промоушена), гость — пока она в комнате
function refreshRoomControls() {
  const role = !roomCtx.roomId ? null : hostRole.controller ? 'host' : 'guest';
  const othersPresent = role === 'host' && hostRole.peerCount > 0;

  roomMenu?.setRole({
    role,
    othersPresent,
    hasSuccessor: role === 'host' && hostRole.successorMemberId !== null,
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

// средний FPS рендера гостя за интервал отчёта (этап 9c)
const fpsMeter = new FpsMeter();

document.addEventListener('visibilitychange', () => {
  const hidden = isPageHidden();

  hostRole.setHidden(hidden);
  handoff.setHidden(hidden);

  // кадры скрытой вкладки (их нет) не тянут средний FPS вниз
  if (!hidden) {
    fpsMeter.reset();
  }
});

// закрытие скрытой вкладки: эпизод закрывается сводкой сейчас — журнал свой
// pagehide уже отработал (подписан раньше), поэтому отправка явная
window.addEventListener('pagehide', () => {
  if (hostRole.flushHiddenLog()) {
    diagnostics.flush();
  }
});

// solo: авторитетный хост в главном потоке (без Worker'а)
let inlineHost = null;

if (isDevBuild) {
  window.__vimpDebug = createDebugApi({
    getHostController: () => hostRole.controller,
    getClientCore: () => clientCore,
    reportUrl: lobbyConfig.debugReportUrl,
    startHandoff: options => handoff.start(options),
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
 * черновика не подменит одобренный), hostRole.createRoom поднимает комнату, а
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

    guest.connectToRoom(roomId);
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

    hostRole.createRoom({
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

// прямые ссылки и быстрая игра (client/session/RouteBoot.js)
const route = new RouteBoot({
  ctx: roomCtx,
  signaling,
  membership,
  config: lobbyConfig,
  gamesById,
  selectActiveGame,
  connectToRoom: roomId => guest.connectToRoom(roomId),
  createRoom: (room, options) => hostRole.createRoom(room, options),
  fetchServers,
  ui: {
    initLobby,
    selectLobbyGame: gameId => {
      const gameSelect = document.getElementById(lobbyConfig.elems.gameId);

      if (gameSelect) {
        gameSelect.value = gameId;
        gameSelect.dispatchEvent(new Event('change'));
      }
    },
    informTech,
    onInformerClick: handler =>
      techInformer.addEventListener('click', handler, { once: true }),
    getHash: () => location.hash,
    setRoute,
    reloadPage,
  },
});

function maybeInitLobby() {
  if (welcomeReceived && authenticated) {
    route.boot();
  }
}

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

  guest.bind();
  hostRole.bind();
  standby.bind();
  promotionFlow.bind();
  handoff.bind();

  document.addEventListener('visibilitychange', () => membership.sendUpdate());

  // свежий средний FPS гостя мастеру (этап 9c); хост его не шлёт
  Ticker.shared.add(() => fpsMeter.frame());
  setInterval(
    () => membership.setFps(fpsMeter.sample()),
    lobbyConfig.migration.auto.fpsReportIntervalMs,
  );

  lobbyAuthModel.publisher.on('authenticated', () => {
    authenticated = true;
    maybeInitLobby();
    // новый вход — новый срок: canHost пересчитается по нему, передача роли
    // хоста — тоже
    membership.armTokenCapsTimer();

    if (hostRole.controller) {
      handoff.armTokenHandoff();
    }

    // повторный вход после logout: маршрут уже разобран, а логин-гейт
    // спрятал лобби — вернуть его, если вкладка не в комнате
    if (route.booted && !roomCtx.entered) {
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

  window.addEventListener('hashchange', () => route.handleHashChange());

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
