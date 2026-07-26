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
