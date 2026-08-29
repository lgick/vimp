// Единица измерения числового поля формы: `unit: 's'` значит, что игра
// хранит значение в миллисекундах, а игрок видит и вводит секунды.
//
// Определение общее на движок (как anchorPattern и normalizeOptions рядом):
// конвертацию делают и билдер формы (client/lib/formBuilder.js), и
// авторитетная валидация хоста (lib/validators.js) — min/max дескриптора
// объявлены в единице ОТОБРАЖЕНИЯ, а по сети едет единица хранения. Две
// копии этого правила разъехались бы молча: форма пропускала бы то, что
// отбивает хост, или наоборот.

/** Значение хранения → значение, в котором объявлены min/max и default. */
export function toDisplay(descriptor, value) {
  return descriptor.unit === 's' ? value / 1000 : value;
}

/** Обратное преобразование: то, что вводит игрок → то, что едет на хост. */
export function toStored(descriptor, value) {
  return descriptor.unit === 's' ? value * 1000 : value;
}

// числовое text-поле: unit задан или numeric:true. Правило одно на билдер и
// на валидацию — иначе поле строится числовым, а проверяется как текст
export function isNumericField(descriptor) {
  return descriptor?.numeric === true || descriptor?.unit !== undefined;
}
