// Разбор списка вариантов дескриптора поля — общий для формы
// (client/lib/formBuilder.js) и для авторитетной проверки
// (lib/validators.js): вариант пишут либо строкой, либо { value, label }.
// Живёт в lib по той же причине, что и formPattern.js: хосту нельзя
// импортировать слой клиента, а разъехаться эти два разбора не должны —
// форма отдаёт ровно то, что хост потом сверяет со списком.

/**
 * @param {Array} [list] - Список вариантов из дескриптора (options/source).
 * @returns {Array<{value: *, label: string}>} Нормализованные варианты.
 */
export function normalizeOptions(list) {
  return (list || []).map(opt =>
    opt !== null && typeof opt === 'object' ? opt : { value: opt, label: String(opt) },
  );
}
