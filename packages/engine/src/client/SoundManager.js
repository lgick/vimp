import { Howl, Howler } from 'howler';

// глобальный лимит звуков
const WORLD_VOICE_LIMIT = 30;

// минимальная дистанция для панорамирования
const MIN_SPATIAL_DISTANCE = 1;

// настройки пространственного звука
const PANNER_SETTINGS = {
  panningModel: 'HRTF', // модель панорамирования
  distanceModel: 'inverse', // модель затухания звука с расстоянием
  refDistance: 150, // расстояние (в px), на котором громкость равна 100%
  maxDistance: 1000, // расстояние, дальше которого звук не слышен
  rolloffFactor: 1, // коэффициент затухания (больше - быстрее затухает)
  coneInnerAngle: 360, // звук распространяется во все стороны одинаково
  coneOuterAngle: 0,
  coneOuterGain: 0,
};

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
   * @returns {Promise<void>} Promise, который разрешается после загрузки.
   */
  async init(soundsConfig) {
    const { codecList, path, sounds } = soundsConfig;
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
                sound: soundInstance.pannerAttr(PANNER_SETTINGS),
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
   * Устанавливает позицию слушателя (игрока) в 2D-пространстве для
   * корректного расчета 3D-звука.
   * @param {number} x - Координата X слушателя.
   * @param {number} y - Координата Y слушателя.
   */
  setListenerPosition(x, y) {
    this._listenerX = x;
    this._listenerY = y;
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
      PANNER_SETTINGS.maxDistance * PANNER_SETTINGS.maxDistance;
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
            this._updateSpatialSound(
              this._activeInstances.get(newSoundId)?.sound,
              newSoundId,
              candidate.position.x,
              candidate.position.y,
              candidate.volume,
            );
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
    for (const [soundId, activeInstance] of this._activeInstances.entries()) {
      if (!activeInstance.loop) {
        continue;
      }

      const regSound = this._registeredSounds.get(activeInstance.ownerId);
      const { sound } = activeInstance;

      if (!regSound) {
        sound.stop(soundId);
        this._activeInstances.delete(soundId);
        continue;
      }

      const { position, volume, rate } = regSound;

      this._updateSpatialSound(sound, soundId, position.x, position.y, volume);

      if (typeof rate === 'number') {
        sound.rate(rate, soundId);
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

          this._activeInstances.delete(soundId);
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
      this._activeInstances.delete(soundId);
    }
  }

  /**
   * Обновляет громкость и 3D-позицию/панораму.
   * @private
   * @param {Howl} sound - Экземпляр Howl.
   * @param {number} soundId - ID конкретного проигрываемого звука.
   * @param {number} x - Координата X источника звука.
   * @param {number} y - Координата Y источника звука.
   * @param {number} volume - Громкость звука.
   */
  _updateSpatialSound(sound, soundId, x, y, volume) {
    if (!sound || typeof soundId !== 'number') {
      return;
    }

    const distance = Math.hypot(x - this._listenerX, y - this._listenerY);

    if (distance >= PANNER_SETTINGS.maxDistance) {
      sound.volume(0, soundId);

      return;
    }

    sound.volume(volume, soundId);

    // если дистанция позволяет панорамировать звук
    if (distance > MIN_SPATIAL_DISTANCE) {
      sound.pos(x - this._listenerX, 0, y - this._listenerY, soundId);
    } else {
      sound.pos(0, 0, 0, soundId); // отключение панорамирования
    }
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
    this._registeredSounds.clear();
    this._listenerX = 0;
    this._listenerY = 0;
  }

  /**
   * Полностью выгружает все загруженные звуки из памяти.
   * Следует вызывать при закрытии вкладки или
   * полном завершении работы приложения.
   */
  destroy() {
    this.reset();
    Howler.unload();
    this._sounds.clear();
  }
}
