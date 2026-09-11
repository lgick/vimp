import { Howl, Howler } from 'howler';

import {
  SPATIAL_DEFAULTS,
  SPATIAL_NUMERIC,
  SPATIAL_MODES,
  PANNING_MODELS,
  DISTANCE_MODELS,
} from '../config/spatialDefaults.js';

// глобальный лимит звуков
const WORLD_VOICE_LIMIT = 30;

// Позиция паннера переписывается не чаще 30 Гц. Каждый pos() внутри
// Howler — это три setValueAtTime на positionX/Y/Z плюс событие 'pos'; на
// 60 Гц и лимите в WORLD_VOICE_LIMIT голосов это тысячи записей
// автоматизации в секунду. WebKit отвечает на такой поток артефактами,
// клиппингом и обрывами (HRTF там — настоящая свёртка на каждый узел, а
// не дешёвая аппроксимация), а на слух панорама между 30 и 60 Гц не
// различается: 30 Гц — обычный темп обновления позиций в игровом звуке
const POSITION_UPDATE_INTERVAL = 1000 / 30;

// Допуск к границе интервала. Кадр 60 Гц приходит каждые ~16.7 мс, и без
// допуска кадр, опоздавший к границе на доли миллисекунды, уезжает на
// следующий: такт скачет между 30 и 20 Гц, а шаг панорамы становится
// неравномерным — ровно то, ради чего гейт и ставился
const POSITION_UPDATE_TOLERANCE = 2;

// Порог смещения, ниже которого позиция не переписывается. Снимает поток
// pos() с неподвижных источников — их большинство: горящий остов,
// эмбиент, подобранный предмет
const POSITION_EPSILON = 0.01;

// Конусные атрибуты узла: звук распространяется во все стороны одинаково.
// Игрой не настраиваются — направленных источников в 2D нет
const CONE_SETTINGS = {
  coneInnerAngle: 360,
  coneOuterAngle: 0,
  coneOuterGain: 0,
};

// Профиль проекции: как мировой вектор (sx, sy) и высота слушателя H
// ложатся на оси Web Audio. Слушатель смотрит в -Z (верх экрана), его
// «вверх» — +Y, поэтому мировой y (растёт вниз) входит со знаком минус
// везде, где попадает на ось Y.
export const SPATIAL_PROFILES = {
  // вид сверху 360°: уши над полем боя, источник под ними
  topDown: {
    panningModel: 'HRTF',
    mapCoords: (sx, sy, h) => [sx, -h, sy],
  },

  // вид сбоку: слышимость лево/право, вертикаль занижена, глубина фиксирована
  sideScroller: {
    panningModel: 'equalpower',
    mapCoords: (sx, sy, h, cfg) => [sx, -sy * cfg.verticalFactor, -h],
  },

  // вид из кабины: сфера перед глазами, глубина фиксирована
  cockpit: {
    panningModel: 'HRTF',
    mapCoords: (sx, sy, h) => [sx, -sy, -h],
  },
};

/**
 * Кубическая интерполяция Эрмита: 0 при value <= min, 1 при value >= max,
 * гладкая (вместе с первой производной) между ними. Гладкость здесь и есть
 * смысл: любой порог с разрывом слышен как щелчок.
 * @param {number} min
 * @param {number} max
 * @param {number} value
 * @returns {number} Значение в [0, 1].
 */
function smoothstep(min, max, value) {
  // вырожденный интервал (innerRadius: 0) — деления не делаем
  if (max <= min) {
    return value > min ? 1 : 0;
  }

  const x = Math.max(0, Math.min(1, (value - min) / (max - min)));

  return x * x * (3 - 2 * x);
}

/**
 * @class SoundManager
 * @description Централизованный "режиссёр звука". Управляет загрузкой,
 * виртуализацией и воспроизведением всех звуков в игре. Использует систему
 * приоритетов и глобальный лимит голосов для предотвращения перегрузки
 * аудио-движка и обеспечения того, чтобы самые важные звуки всегда были слышны.
 */
export default class SoundManager {
  constructor() {
    // хранение загруженных звуков { sound, config }
    this._sounds = new Map();

    // хранит соответствие soundId -> { sound, ownerId, loop }
    this._activeInstances = new Map();

    // реестр всех зарегистрированных звуковых источников
    this._registeredSounds = new Map();

    // экземпляры, уже переведённые на equalpower (непространственные):
    // pannerAttr ставится один раз на экземпляр, а не каждый кадр
    this._equalPowerIds = new Set();

    // экземпляры, у которых PannerNode УЖЕ создан. Множество обслуживает
    // только возврат в центр для spatial: false — мировой источник
    // получает узел сразу, на первом же кадре. Howler создаёт узел лениво
    // — на первом pos()/pannerAttr(id) — и заканчивает создание парой
    // pause()/play() (setupPanner в howler.js), то есть щелчком, поэтому
    // источнику игрока узел не заводится вовсе: сигнал идёт прямо в gain,
    // сохраняя стерео сэмпла
    this._pannedIds = new Set();

    // последняя записанная в узел позиция: soundId -> [x, y, z]. Служит
    // порогом POSITION_EPSILON — неподвижный источник не переписывает
    // автоматизацию паннера впустую
    this._pannerPos = new Map();

    // время последней записи позиций (performance.now), общее на кадр:
    // гейт POSITION_UPDATE_INTERVAL
    this._lastPositionWrite = -Infinity;

    // разрешённая геометрия пространственного звука: числа профиля + его
    // mapCoords. Ставится в init(), между матчами (reset) не меняется
    this._spatial = this._resolveSpatialConfig();

    // множитель зума камеры: 1 — покой, < 1 — динамическое отдаление
    this._listenerScale = 1;

    // позиция слушателя
    this._listenerX = 0;
    this._listenerY = 0;
  }

  /**
   * Производит базовую настройку Howler, асинхронно загружает все звуки,
   * определенные в конфигурации.
   * Сохраняет как сам экземпляр Howl, так и его конфигурацию (приоритет).
   * @param {object} soundsConfig - Объект конфигурации звуков.
   * @param {string[]} soundsConfig.codecList - Список поддерживаемых кодеков
   * (['webm', 'mp3']).
   * @param {string} soundsConfig.path - Путь к директории со звуками.
   * @param {object} soundsConfig.sounds - Словарь, где ключ - имя звука,
   * а значение - объект конфигурации { file, priority, loop, volume }.
   * @param {object} [soundsConfig.spatial] - Геометрия пространственного
   * звука: mode ('topDown' | 'sideScroller' | 'cockpit'), virtualElevation,
   * innerRadius, verticalFactor, panningModel ('HRTF' | 'equalpower'),
   * distanceModel ('linear' | 'inverse' | 'exponential'), refDistance,
   * maxDistance, rolloffFactor. Все ключи необязательны, отсутствующие
   * берутся из движковых дефолтов.
   * @returns {Promise<void>} Promise, который разрешается после загрузки.
   */
  async init(soundsConfig) {
    const { codecList, path, sounds, spatial } = soundsConfig;

    this._spatial = this._resolveSpatialConfig(spatial);

    const supportedCodec = codecList.find(codec => Howler.codecs(codec));

    Howler.usingWebAudio = true;
    Howler.autoSuspend = false;
    Howler.pos(0, 0, 0);
    Howler.volume(0.7);

    // устанавливает ориентацию (направление взгляда) слушателя.
    // вектор "вперед" (0, 0, -1) - соответствует верху экрана
    // вектор "вверх" (0, 1, 0) - вектор "вверх" для аудиосистемы
    Howler.orientation(0, 0, -1, 0, 1, 0);

    if (!supportedCodec) {
      console.error(`No supported audio codec found from: ${codecList}`);
      return;
    }

    const loadingPromises = Object.entries(sounds).map(
      ([soundName, soundData]) => {
        const fileName = soundData.file;
        const loop = !!soundData.loop;
        const volume = soundData.volume ?? 0.5;
        const url = `${path}${fileName}.${supportedCodec}`;

        return new Promise((resolve, reject) => {
          const soundInstance = new Howl({
            src: [url],
            preload: true,
            html5: false,
            loop,
            volume,
            onload: () => {
              this._sounds.set(soundName, {
                sound: soundInstance.pannerAttr({
                  panningModel: this._spatial.panningModel,
                  distanceModel: this._spatial.distanceModel,
                  refDistance: this._spatial.refDistance,
                  maxDistance: this._spatial.maxDistance,
                  rolloffFactor: this._spatial.rolloffFactor,
                  ...CONE_SETTINGS,
                }),
                config: { ...soundData, priority: soundData.priority ?? 50 },
              });

              resolve(soundName);
            },
            onloaderror: (_id, error) => {
              reject({
                message: `Error loading "${soundName}" from ${url}`,
                error,
              });
            },
          });
        });
      },
    );

    // Promise.allSettled, чтобы сбой загрузки одного файла
    // не прерывал загрузку остальных
    const results = await Promise.allSettled(loadingPromises);

    results.forEach(result => {
      if (result.status === 'rejected') {
        console.error(result.reason.message, result.reason.error);
      }
    });
  }

  /**
   * Возвращает конфигурацию для указанного звука.
   * @param {string} soundName - Имя звука.
   * @returns {object | undefined} Конфигурация звука или undefined.
   */
  getSoundConfig(soundName) {
    return this._sounds.get(soundName)?.config;
  }

  /**
   * Устанавливает позицию слушателя и текущий зум камеры.
   * @param {number} x - Мировая координата X слушателя.
   * @param {number} y - Мировая координата Y слушателя.
   * @param {number} [scale=1] - Множитель зума камеры: 1 в покое, меньше
   * единицы при динамическом отдалении. Вызов с двумя аргументами
   * сохраняет прежнее поведение полностью.
   */
  setListenerPosition(x, y, scale = 1) {
    this._listenerX = x;
    this._listenerY = y;
    this._listenerScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  }

  /**
   * Воспроизводит системный/UI звук немедленно, в обход системы приоритетов.
   * Следует использовать для критически важных звуков, не относящихся к
   * игровому миру (например звук начала раунда).
   * @param {string} soundName - Имя звука для воспроизведения.
   */
  playSystemSound(soundName) {
    this._sounds.get(soundName)?.sound.play();
  }

  /**
   * Регистрирует звук.
   * Возвращает уникальный ID для управления этим источником.
   * @param {string} soundName - Имя звука (ключ из файла sounds.js).
   * @param {object} data - Начальные параметры звука.
   * @param {object} data.position - { x: number, y: number }.
   * @param {number} [data?.rate] - Скорость воспроизведения.
   * @param {number} [data?.volume] - Громкость.
   * @param {boolean} [data?.spatial=true] - Принадлежит ли звук миру.
   *   `false` — источник игрока (двигатель и выстрел своего танка): он
   *   стоит ровно на слушателе, и HRTF на нулевой дистанции сворачивается
   *   в гребенчатую окраску («гул»), а не в тишину панорамы. Такому звуку
   *   PannerNode не создаётся вовсе — он идёт прямо в gain и остаётся
   *   стерео. Флаг рассчитан на ОДНОКРАТНОЕ переключение (владелец
   *   узнаёт, что танк локальный, уже после конструктора): экземпляр,
   *   который успел побывать мировым, переводится на equalpower
   *   необратимо — HRTF обратно не возвращается.
   * @param {function} [callback] - Функция, вызываемая по завершении.
   * @returns {symbol | null} Уникальный ID звука или null, если звук не найден.
   */
  registerSound(soundName, data, callback) {
    const soundData = this._sounds.get(soundName);

    if (!soundData) {
      console.warn(`SoundManager: Sound "${soundName}" does not exist.`);

      return null;
    }

    const id = Symbol(soundName);
    const registration = {
      spatial: true,
      ...soundData.config,
      ...data,
      sound: soundData.sound,
      id,
      activeSoundId: null, // ID от Howler, когда звук будет играть
      callback,
    };

    this._registeredSounds.set(id, registration);

    return id;
  }

  /**
   * Снимает звук с регистрации. Если он играет, он будет остановлен.
   * @param {symbol} id - ID, полученный от `registerSound`.
   */
  unregisterSound(id) {
    const sound = this._registeredSounds.get(id);

    if (sound && sound.activeSoundId !== null) {
      this._internalStop(sound.activeSoundId);
    }

    this._registeredSounds.delete(id);
  }

  /**
   * Снимает звук с регистрации, но даёт уже звучащему одноразовому сэмплу
   * доиграть. Для сущностей, которые исчезают раньше своего звука
   * (например, взорвавшаяся бомба).
   * @param {symbol} id - ID, полученный от `registerSound`.
   */
  releaseSound(id) {
    const sound = this._registeredSounds.get(id);

    if (!sound) {
      return;
    }

    // луп обязан замолчать вместе с владельцем, one-shot — доиграть:
    // updateActiveSounds() не-лупы не трогает, а обработчик 'end' сам
    // подчистит _activeInstances
    if (sound.loop && sound.activeSoundId !== null) {
      this._internalStop(sound.activeSoundId);
    }

    this._registeredSounds.delete(id);
  }

  /**
   * Обновляет параметры зарегистрированного звука.
   * @param {symbol} id - ID, полученный от `registerSound`.
   * @param {object} data - Новые параметры.
   */
  updateSoundData(id, data) {
    const sound = this._registeredSounds.get(id);

    if (sound) {
      Object.assign(sound, data);
    }
  }

  /**
   * Главный метод - "режиссёр", мозг всей звуковой системы.
   * Анализирует все существующие и заявленные звуки, пересчитывает их важность
   * на основе приоритета и расстояния, и решает, какие из них должны
   * звучать в данный момент, соблюдая глобальный лимит голосов.
   * Вызывается один раз за кадр.
   */
  processAudibility() {
    const candidates = [];
    const maxDistSquared =
      this._spatial.maxDistance * this._spatial.maxDistance;
    const { _listenerX: lx, _listenerY: ly } = this;
    const deleteList = [];

    // сбор и предварительный отсев кандидатов
    for (const regSound of this._registeredSounds.values()) {
      const dx = regSound.position.x - lx;
      const dy = regSound.position.y - ly;
      const distanceSquared = dx * dx + dy * dy;

      // если звук слишком далеко и он одноразовый, то удаление
      if (distanceSquared >= maxDistSquared && !regSound.loop) {
        deleteList.push(regSound.id);
        continue;
      }

      // расчет приоритета
      const basePriority = regSound.priority;

      // дистанция 1.0, если звук в той же точке,
      // чтобы избежать деления на ноль
      regSound.priorityScore =
        (basePriority * basePriority) / Math.max(distanceSquared, 1.0);
      regSound.isPlaying = regSound.activeSoundId !== null;

      candidates.push(regSound);
    }

    deleteList.forEach(id => this._registeredSounds.delete(id));

    // если кандидатов нет, то очистка одноразовых звуков и выход
    if (candidates.length === 0) {
      this._cleanupUnplayedOneShots();
      return;
    }

    // сортировка кандидатов по убыванию очков приоритета
    candidates.sort((a, b) => b.priorityScore - a.priorityScore);

    const audibleCandidates =
      candidates.length > WORLD_VOICE_LIMIT
        ? candidates.slice(0, WORLD_VOICE_LIMIT)
        : candidates;

    const audibleSet = new Set(audibleCandidates);

    // синхронизация и очистка
    for (const candidate of candidates) {
      const shouldBePlaying = audibleSet.has(candidate);

      if (candidate.isPlaying) {
        if (!shouldBePlaying) {
          this._internalStop(candidate.activeSoundId);
          candidate.activeSoundId = null;
        }
      } else {
        if (shouldBePlaying) {
          const newSoundId = this._internalPlay(candidate);

          if (newSoundId !== null) {
            candidate.activeSoundId = newSoundId;

            const started = this._activeInstances.get(newSoundId)?.sound;
            const { x, y } = candidate.position;

            // на старте звука гейт частоты не применяется: позиция обязана
            // попасть в узел сразу, иначе первый кадр сэмпла звучит из центра
            if (
              this._applyVolume(
                started,
                newSoundId,
                x,
                y,
                candidate.volume,
                candidate.spatial,
              )
            ) {
              this._updateSpatialSound(
                started,
                newSoundId,
                x,
                y,
                candidate.spatial,
              );
            }
          }
        }
      }
    }

    // очистка несыгравших одноразовых звуков
    this._cleanupUnplayedOneShots();
  }

  /**
   * Обновляет параметры всех активных зацикленных звуков.
   * Вызывается каждый кадр после `processAudibility`.
   */
  updateActiveSounds() {
    // гейт частоты: под него попадает ТОЛЬКО запись позиции в паннер.
    // Громкость, уборка мёртвых экземпляров и rate идут каждый кадр —
    // громкость игра ведёт от скорости (двигатель), и ступенька в 30 Гц
    // была бы слышна, а глушение за maxDistance обязано срабатывать в том
    // же кадре, в котором источник ушёл за радиус
    const now = performance.now();
    const writePosition =
      now - this._lastPositionWrite >=
      POSITION_UPDATE_INTERVAL - POSITION_UPDATE_TOLERANCE;

    if (writePosition) {
      this._lastPositionWrite = now;
    }

    for (const [soundId, activeInstance] of this._activeInstances.entries()) {
      if (!activeInstance.loop) {
        continue;
      }

      const regSound = this._registeredSounds.get(activeInstance.ownerId);
      const { sound } = activeInstance;

      if (!regSound) {
        sound.stop(soundId);
        this._forgetInstance(soundId);
        continue;
      }

      const { position, volume, rate, spatial } = regSound;
      const audible = this._applyVolume(
        sound,
        soundId,
        position.x,
        position.y,
        volume,
        spatial,
      );

      if (audible && writePosition) {
        this._updateSpatialSound(
          sound,
          soundId,
          position.x,
          position.y,
          spatial,
        );
      }

      // rate только на изменение: Howler на каждый вызов делает два seek(),
      // переписывает _rateSeek/_playStart и пересоздаёт таймер конца петли
      // — на 60 Гц это лишняя нагрузка и лишние события 'end' на каждом
      // обороте
      if (typeof rate === 'number' && rate !== activeInstance.rate) {
        sound.rate(rate, soundId);
        activeInstance.rate = rate;
      }
    }
  }

  /**
   * @private Внутренний метод для воспроизведения звука через Howler.
   */
  _internalPlay(candidate) {
    const { sound, id, loop, callback } = candidate;
    const soundId = sound.play();

    if (typeof soundId !== 'number') {
      return null;
    }

    this._activeInstances.set(soundId, {
      sound,
      ownerId: id,
      loop,
    });

    if (!loop) {
      sound.once(
        'end',
        () => {
          if (typeof callback === 'function') {
            callback();
          }

          // по завершению удаляем из активных инстансов и из реестра
          const regSound = this._registeredSounds.get(id);

          if (regSound && regSound.activeSoundId === soundId) {
            this._registeredSounds.delete(id);
          }

          this._forgetInstance(soundId);
        },
        soundId,
      );
    }

    return soundId;
  }

  /**
   * @private Внутренний метод для остановки экземпляра звука.
   */
  _internalStop(soundId) {
    const instanceData = this._activeInstances.get(soundId);

    if (instanceData) {
      instanceData.sound.stop(soundId);
      this._forgetInstance(soundId);
    }
  }

  /**
   * @private Забывает всё, что менеджер помнил про экземпляр Howler.
   * Единственная точка уборки: набор коллекций растёт, а пропущенная точка
   * — это утечка, которую видно только по памяти, ни один тест её не
   * поймает.
   * @param {number} soundId - ID экземпляра от Howler.
   */
  _forgetInstance(soundId) {
    this._activeInstances.delete(soundId);
    this._equalPowerIds.delete(soundId);
    this._pannedIds.delete(soundId);
    this._pannerPos.delete(soundId);
  }

  /**
   * @private Сводит объявленную игрой геометрию с движковыми дефолтами.
   * Плагин объявляет её в parts.sounds.spatial; неверное значение не
   * должно ломать аудиоконтекст, поэтому каждый ключ проверяется отдельно
   * и по одному падает на дефолт с предупреждением в консоль. Статически
   * то же самое ловит правило контракта E6 — здесь страховка на прод.
   * @param {object} [custom] - Блок parts.sounds.spatial из конфига игры.
   * @returns {object} Числа геометрии + panningModel + mapCoords профиля.
   */
  _resolveSpatialConfig(custom = {}) {
    const source = custom && typeof custom === 'object' ? custom : {};
    const warn = (key, value, fallback) =>
      console.warn(
        `[SoundManager] spatial.${key}: invalid value ${JSON.stringify(
          value,
        )}, using ${JSON.stringify(fallback)}`,
      );

    // число нужного знака, иначе дефолт. Знак объявлен в SPATIAL_NUMERIC —
    // там же, откуда его читает правило контракта E6
    const num = key => {
      const value = source[key];
      const fallback = SPATIAL_DEFAULTS[key];

      if (value === undefined) {
        return fallback;
      }

      const ok =
        Number.isFinite(value) &&
        (SPATIAL_NUMERIC[key] === 'positive' ? value > 0 : value >= 0);

      if (!ok) {
        warn(key, value, fallback);
      }

      return ok ? value : fallback;
    };

    // значение из закрытого списка, иначе дефолт
    const pick = (key, list, fallback) => {
      const value = source[key];

      if (value === undefined) {
        return fallback;
      }

      if (!list.includes(value)) {
        warn(key, value, fallback);

        return fallback;
      }

      return value;
    };

    const mode = pick('mode', SPATIAL_MODES, SPATIAL_DEFAULTS.mode);
    const profile = SPATIAL_PROFILES[mode];

    let refDistance = num('refDistance');
    let maxDistance = num('maxDistance');

    // PannerNode с maxDistance <= refDistance ведёт себя неопределённо.
    // Откатываются ОБА ключа: пара обязана остаться согласованной, а
    // починка одной половины дала бы геометрию, которую не просил никто.
    // Сравниваются разрешённые значения, поэтому объявить одну дистанцию
    // против дефолта второй тоже нарушение — то же условие проверяет
    // статически правило контракта E6
    if (maxDistance <= refDistance) {
      console.warn(
        `[SoundManager] spatial.maxDistance (${maxDistance}) must exceed ` +
          `spatial.refDistance (${refDistance}); both fall back to ` +
          `${SPATIAL_DEFAULTS.refDistance}/${SPATIAL_DEFAULTS.maxDistance}`,
      );
      refDistance = SPATIAL_DEFAULTS.refDistance;
      maxDistance = SPATIAL_DEFAULTS.maxDistance;
    }

    return {
      mode,
      virtualElevation: num('virtualElevation'),
      innerRadius: num('innerRadius'),
      verticalFactor: num('verticalFactor'),
      distanceModel: pick(
        'distanceModel',
        DISTANCE_MODELS,
        SPATIAL_DEFAULTS.distanceModel,
      ),
      panningModel: pick('panningModel', PANNING_MODELS, profile.panningModel),
      refDistance,
      maxDistance,
      rolloffFactor: num('rolloffFactor'),
      mapCoords: profile.mapCoords,
    };
  }

  /**
   * @private Применяет громкость и решает, слышим ли источник. Отделено от
   * записи позиции нарочно: позиция пишется под гейтом 30 Гц, а громкость
   * обязана идти каждый кадр — игра ведёт её от скорости (двигатель), и
   * ступенька в 30 Гц слышна, а глушение за maxDistance должно срабатывать
   * в том же кадре, в котором источник ушёл за радиус.
   * @param {Howl} sound - Экземпляр Howl.
   * @param {number} soundId - ID конкретного проигрываемого экземпляра.
   * @param {number} x - Мировая координата X источника.
   * @param {number} y - Мировая координата Y источника.
   * @param {number} volume - Громкость.
   * @param {boolean} [spatial=true] - Принадлежит ли звук миру.
   * @returns {boolean} `false`, если источник заглушен и позицию писать
   * незачем.
   */
  _applyVolume(sound, soundId, x, y, volume, spatial = true) {
    if (!sound || typeof soundId !== 'number') {
      return false;
    }

    if (spatial === false) {
      sound.volume(volume, soundId);

      return true;
    }

    const dx = x - this._listenerX;
    const dy = y - this._listenerY;

    // отсечка в мировых координатах: она обязана совпадать с maxDistance
    // самого PannerNode, поэтому зумом НЕ масштабируется — иначе движок
    // считал бы источник слышимым там, где узел уже отдал тишину
    if (Math.hypot(dx, dy) >= this._spatial.maxDistance) {
      sound.volume(0, soundId);

      return false;
    }

    sound.volume(volume, soundId);

    return true;
  }

  /**
   * Обновляет 3D-позицию источника. Позиция считается ОДНОЙ непрерывной
   * формулой на каждом кадре: слушатель поднят над плоскостью игры на
   * virtualElevation, а внутри innerRadius вектор на источник плавно
   * гасится к нулю (smoothstep). Прежняя дед-зона по направлению
   * (MIN_SPATIAL_DISTANCE) убрана: она переключала источник между двумя
   * разными состояниями — «узла нет, сухое стерео» и «HRTF в крайнем ухе»
   * — и этот разрыв тембра был слышен на дистанции в пару единиц.
   * Громкость здесь не трогается — ей занимается `_applyVolume`.
   * @private
   * @param {Howl} sound - Экземпляр Howl.
   * @param {number} soundId - ID конкретного проигрываемого экземпляра.
   * @param {number} x - Мировая координата X источника.
   * @param {number} y - Мировая координата Y источника.
   * @param {boolean} [spatial=true] - Принадлежит ли звук миру.
   */
  _updateSpatialSound(sound, soundId, x, y, spatial = true) {
    if (!sound || typeof soundId !== 'number') {
      return;
    }

    if (spatial === false) {
      // источник игрока: звук не принадлежит миру, он принадлежит игроку.
      // Паннер ему не нужен ни в каком виде — ни HRTF (на нулевой
      // дистанции это не тишина панорамы, а фронтальная свёртка:
      // гребенчатая окраска, из-за которой двигатель слышен как гул), ни
      // equalpower (тот схлопывает стерео сэмпла в моно). Пока узла нет,
      // pos() не зовётся вовсе: Howler создал бы паннер и щёлкнул
      // pause()/play()
      this._recenterIfPanned(sound, soundId, true);

      return;
    }

    const dx = x - this._listenerX;
    const dy = y - this._listenerY;
    const distance = Math.hypot(dx, dy);

    // зум камеры поднимает уши вместе с камерой: при отдалении картинка
    // сжимается, и стереобаза обязана сжаться так же, иначе звук шире
    // того, что видит глаз
    const zoom = this._listenerScale;
    const elevation = this._spatial.virtualElevation / zoom;
    const spread = smoothstep(0, this._spatial.innerRadius / zoom, distance);

    const [px, py, pz] = this._spatial.mapCoords(
      dx * spread,
      dy * spread,
      elevation,
      this._spatial,
    );

    this._writePos(sound, soundId, px, py, pz);
  }

  /**
   * @private Пишет позицию в паннер, если она изменилась заметнее
   * POSITION_EPSILON. Единственная точка записи: у неподвижного источника
   * позиция уже в узле, и повторная запись — только лишняя автоматизация,
   * а именно её поток WebKit и не переносит.
   * @param {Howl} sound - Экземпляр Howl.
   * @param {number} soundId - ID конкретного проигрываемого экземпляра.
   * @param {number} px - Координата X в осях Web Audio.
   * @param {number} py - Координата Y в осях Web Audio.
   * @param {number} pz - Координата Z в осях Web Audio.
   */
  _writePos(sound, soundId, px, py, pz) {
    const written = this._pannerPos.get(soundId);

    if (written !== undefined) {
      if (
        Math.abs(written[0] - px) < POSITION_EPSILON &&
        Math.abs(written[1] - py) < POSITION_EPSILON &&
        Math.abs(written[2] - pz) < POSITION_EPSILON
      ) {
        return;
      }

      // массив переиспользуется: до WORLD_VOICE_LIMIT записей в 33 мс —
      // это сотни лишних аллокаций в секунду на ровном месте
      written[0] = px;
      written[1] = py;
      written[2] = pz;
    } else {
      this._pannerPos.set(soundId, [px, py, pz]);
    }

    sound.pos(px, py, pz, soundId);
    this._pannedIds.add(soundId);
  }

  /**
   * @private Возвращает в центр экземпляр, у которого PannerNode УЖЕ есть
   * (источник успел побывать в стороне от слушателя). Экземпляр без узла
   * не трогается: создание паннера — это лишний узел в цепочке, потеря
   * стерео и щелчок от pause()/play() внутри setupPanner Howler'а.
   * @param {boolean} [equalPower=false] - Перевести узел на equalpower.
   *   Так делается только для источника игрока, и перевод ОДНОСТОРОННИЙ:
   *   HRTF обратно не возвращается. Рассчитано на однократное
   *   переключение флага `spatial` (владелец узнаёт, что танк локальный,
   *   уже после конструктора); обратный переход потребовал бы явного
   *   восстановления HRTF.
   */
  _recenterIfPanned(sound, soundId, equalPower = false) {
    if (!this._pannedIds.has(soundId)) {
      return;
    }

    if (equalPower) {
      this._applyEqualPower(sound, soundId);
    }

    // через тот же порог: собственный двигатель игрока звучит непрерывно и
    // всегда, и переписывать ему центр каждый кадр — последнее, что стоит
    // оставлять в потоке, который чинится ради WebKit
    this._writePos(sound, soundId, 0, 0, 0);
  }

  /**
   * @private Переводит экземпляр звука на equalpower — один раз на
   * экземпляр: pannerAttr на каждом кадре пересобирал бы panner-узел.
   */
  _applyEqualPower(sound, soundId) {
    if (this._equalPowerIds.has(soundId)) {
      return;
    }

    sound.pannerAttr({ panningModel: 'equalpower' }, soundId);
    this._equalPowerIds.add(soundId);
  }

  /**
   * @private
   * Удаляет из реестра одноразовые звуки, которые были заявлены,
   * но не попали в лимит воспроизведения в текущем кадре.
   */
  _cleanupUnplayedOneShots() {
    for (const [id, regSound] of this._registeredSounds.entries()) {
      if (!regSound.loop && regSound.activeSoundId === null) {
        this._registeredSounds.delete(id);
      }
    }
  }

  /**
   * Выключает все звуки.
   */
  mute() {
    Howler.mute(true);
  }

  /**
   * Включает все звуки после выключения.
   */
  unmute() {
    Howler.mute(false);
  }

  /**
   * Останавливает все играющие звуки и
   * сбрасывает внутреннее состояние "режиссёра".
   * Используется при смене карты или полной перезагрузке.
   */
  reset() {
    Howler.stop();
    this._activeInstances.clear();
    this._equalPowerIds.clear();
    this._pannedIds.clear();
    this._pannerPos.clear();
    this._lastPositionWrite = -Infinity;

    // луп переживает reset: его владелец жив, и ближайший
    // processAudibility() запустит звук заново. Одноразовый — нет:
    // Howler.stop() не шлёт 'end', регистрация сыгравшего сэмпла осталась
    // бы в реестре и прозвучала бы второй раз с начала
    for (const [id, regSound] of this._registeredSounds.entries()) {
      if (regSound.loop) {
        regSound.activeSoundId = null;
      } else {
        this._registeredSounds.delete(id);
      }
    }

    this._listenerX = 0;
    this._listenerY = 0;
    this._listenerScale = 1;
  }

  /**
   * Полностью выгружает все загруженные звуки из памяти.
   * Следует вызывать при закрытии вкладки или
   * полном завершении работы приложения.
   */
  destroy() {
    this.reset();
    this._registeredSounds.clear();
    Howler.unload();
    this._sounds.clear();
  }
}
