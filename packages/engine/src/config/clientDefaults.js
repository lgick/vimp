// Движковые дефолты клиентского CONFIG_DATA (порт 0): интерполяция,
// режимы/служебные клавиши, DOM-структуры движковых модулей, технические
// сообщения. Игровая половина бывшего config/client.js — src/config/client.js
// в репозитории игры (например vimp-tanks); merge выполняет buildClientConfig
// через HostPlugin.buildClientGameConfig.
export default {
  // ***** interpolation ***** //
  // snapshot-интерполяция: мир рендерится в прошлом (serverNow − delay)
  interpolation: {
    delay: 100, // мс; ~3 кадра при 30 пакетах/сек
    maxFrameAge: 1000, // мс; страховочная очистка старых кадров буфера
  },

  // ***** parts ***** //
  // Геометрия пространственного звука. Числа — в МИРОВЫХ единицах игры, не
  // в экранных пикселях: у игры с mapScale 0.3 и baseScale 5 мировая
  // единица впятеро меньше пикселя. Дефолты рассчитаны на масштаб 1:1,
  // игра со своим масштабом объявляет parts.sounds.spatial сама.
  parts: {
    sounds: {
      spatial: {
        // 'topDown' | 'sideScroller' | 'cockpit'
        mode: 'topDown',

        // высота ушей над плоскостью игры: она же ширина стереобазы.
        // Больше — мягче панорама вблизи игрока, меньше — агрессивнее
        // разделение по ушам. Ориентир: половина видимой высоты экрана
        virtualElevation: 180,

        // габарит игрока: всё, что звучит внутри этого радиуса, плавно
        // сводится к центру и распределяется поровну в оба уха
        innerRadius: 40,

        // только sideScroller: вклад вертикали в панораму. В платформере
        // высота на слух почти не читается
        verticalFactor: 0.2,

        // атрибуты PannerNode: ставятся один раз на Howl и покадрово не
        // пересчитываются. refDistance больше virtualElevation, иначе
        // источник под игроком тише, чем был до виртуальной высоты
        distanceModel: 'inverse',
        refDistance: 200,
        maxDistance: 1200,
        rolloffFactor: 0.9,
      },
    },
  },

  // ***** modules ***** //
  modules: {
    canvasManager: {
      dynamicCamera: {
        // сила смещения камеры вперед (чем больше, тем дальше смотрит)
        lookAheadFactor: 30,

        // чувствительность зума (0 - 1)
        // 0.1 - мягкое отдаление
        // 0.5 - агрессивное отдаление
        // 1.0 - экстремально сильная реакция на скорость
        zoomOutFactor: 0.5,

        // максимально возможное отдаление (от базового масштаба)
        maxZoomOut: 0.6,

        // плавность изменений позиции камеры (0 - 1)
        smoothnessPosition: 0.008,

        // плавность изменений зума камеры (0 - 1)
        smoothnessZoom: 0.005,

        // плавность входящей скорости (0 - 1)
        // (игнорирует мелкие рывки сети, но реагирует на разгон)
        smoothnessVelocity: 0.15,
      },
    },

    controls: {
      modes: {
        67: 'chat', // чат (c)
        77: 'vote', // опрос (m)
        9: 'stat', // статистика (tab)
      },
      cmds: {
        27: 'escape', // отмена (escape)
        13: 'enter', // ввод (enter)
      },
    },

    chat: {
      elems: {
        chatBox: 'chat-box',
        cmd: 'cmd',
      },
      params: {
        listLimit: 5,
        lineTime: 15000,
        cacheMin: 200,
        cacheMax: 300,
      },
    },

    panel: {
      // контейнер панели; ячейки генерирует PanelView по схеме игры (fields)
      containerId: 'panel',
    },

    stat: {
      elems: {
        stat: 'stat',
      },
    },

    vote: {
      elems: {
        voteId: 'vote',
        titleClass: 'vote-title',
        listClass: 'vote-list',
        navClass: 'vote-nav',
        navActiveClass: 'active',
      },
    },
  },

  // game information
  gameInform: {
    id: 'game-informer',
  },

  // technical information
  techInformList: [
    `Server is full! Please wait or try again later.
     Max players: {0}
     You are #{1} in the queue.
    `,

    'Connection closed due to a new login from another device!',

    'Loading...',

    'Kicked for inactivity.',

    'Connection terminated due to high network latency.',

    'Connection terminated due to missed network pings.',

    'Room is full! Max players: {0}. Try again later.',
  ],
};
