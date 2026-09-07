# Этап 3. Проброс зума камеры

Репозиторий: `/Users/dmitry/Sites/my/vimp`.
Предварительное чтение: [`README.md`](README.md).
Зависит от: [этапа 2](stage_2.md) (метод `setListenerPosition(x, y, scale)`).

## Что откуда берётся

Зум живёт в
`packages/engine/src/client/components/model/CanvasManager.js`:
`this._camZoomModifier` — объявление на строке 23, пересчёт на строках
254–276 (`lerp` к `max(maxZoomOut, 1 - avgSpeed * zoomOutFactor)`,
сглаживание `smoothnessZoom`).

Брать нужно именно его, а **не** `currentScale * _camZoomModifier`
(строка 297): `currentScale` у каждого полотна свой и зависит от подгонки
карты и размера окна, а `virtualElevation` объявлен игрой в мировых
единицах и от размера окна зависеть не должен (см. «Единицы измерения» в
`README.md`).

## 3.1. Модель — геттер

Файл: `packages/engine/src/client/components/model/CanvasManager.js`

1. В конструкторе, рядом со строкой 16 (`this._data = {};`), добавить:

   ```javascript
       // хотя бы одно полотно с динамической камерой
       this._hasDynamicCamera = false;
   ```

2. В цикле заполнения `this._data` (строки 66–83), рядом с
   `dynamicCamera: !!canvasData.dynamicCamera,` выставлять флаг:

   ```javascript
           this._hasDynamicCamera ||= !!canvasData.dynamicCamera;
   ```

3. Рядом с геттером `pointerCanvasId` (строки 86–88) добавить:

   ```javascript
     // множитель динамического зума для позиции слушателя звука. Если ни
     // одно полотно динамическую камеру не использует, зум обязан быть 1:
     // сам модификатор считается всегда, и звук «отъезжал» бы там, где
     // картинка стоит на месте
     getCameraZoom() {
       return this._hasDynamicCamera ? this._camZoomModifier : 1;
     }
   ```

## 3.2. Контроллер — проброс

Файл: `packages/engine/src/client/components/controller/CanvasManager.js`
(синглтон, тонкая обёртка над моделью и view). После `updateCoords`
(строки 18–20):

```javascript
  // текущий множитель зума камеры (для позиции слушателя звука)
  getCameraZoom() {
    return this._model.getCameraZoom();
  }
```

## 3.3. Порядок вызовов в `main.js`

Файл: `packages/engine/src/client/main.js`, функция `applyCamera`
(строки 903–909).

Сейчас слушатель обновляется **до** полотна, то есть зум был бы на кадр
устаревшим. Заменить тело функции на:

```javascript
// применяет данные камеры (позиция слушателя звука + полотно)
function applyCamera(camera) {
  if (camera && camera !== 0) {
    // порядок важен: зум пересчитывается внутри updateCoords, а слушателю
    // нужен зум ЭТОГО кадра, а не прошлого
    modules.canvasManager.updateCoords(camera);
    soundManager.setListenerPosition(
      camera[0],
      camera[1],
      modules.canvasManager.getCameraZoom(),
    );
  }
}
```

Перестановка безопасна: `updateCoords` считает камеру и публикует событие во
view, от `soundManager` не зависит. `applyCamera` вызывается из `applyShot`
(дискретные кадры интерполяции) и из `renderTick` по флагу
`HOT_FLAGS.CAMERA` — оба пути получают зум одинаково.

## Готово, когда

- `npx eslint .` зелёный;
- `npm test` не хуже, чем после этапа 2 (новых падений нет);
- `grep -n "getCameraZoom" packages/engine/src -r` показывает ровно три
  места: модель, контроллер, `main.js`.
