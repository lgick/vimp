import { ERROR, WARN, skip, verdict } from '../result.js';
import { resolveValidator } from '../../../lib/validators.js';
import {
  formControls,
  ACTIVE_FORM_CONTROLS,
} from '../../../lib/formControls.js';

// authSchema. Четыре ошибки, каждая из которых уже случалась:
// formId вместо fieldsId (контейнер резолвится в null и экран авторизации
// умирает TypeError на первом рендере), поле ника (личность приходит из
// JWT лобби) и поле выбора модели под своим именем — движок читает
// params.model, всё остальное до Participant не доезжает, и имя валидатора,
// которого нет в authSchema.validators (поле не проверяется никем).
const NICKNAME = /^(name|nick|nickname|player|playername|login|username)$/i;

export default {
  id: 'C10',
  name: 'authSchema',
  level: ERROR,
  title:
    'authSchema: fieldsId, no nickname field, the model field, inline ' +
    'options, resolvable validators',

  check(ctx) {
    if (!ctx.authSchema) {
      return skip('no HostPlugin.authSchema');
    }

    const { elems = {}, params = [] } = ctx.authSchema;
    const violations = [];
    const retired = [];

    if (elems.formId !== undefined) {
      violations.push(
        "authSchema.elems.formId does not exist — the key is 'fieldsId'",
      );
    }

    if (elems.fieldsId === undefined) {
      violations.push(
        'authSchema.elems.fieldsId is missing — the engine fills that ' +
          'container with the form fields',
      );
    }

    const validators = ctx.authSchema.validators;

    for (const field of params) {
      if (NICKNAME.test(field.name)) {
        violations.push(
          `authSchema param "${field.name}" looks like a nickname field — ` +
            'identity comes from the lobby JWT',
        );
      }

      const control = field.options?.control;

      if (control !== undefined && !formControls.has(control)) {
        violations.push(
          `authSchema param "${field.name}": control "${control}" does not ` +
            `exist (${ACTIVE_FORM_CONTROLS.join(', ')}) — the form throws ` +
            "'unknown control' and the auth screen never renders",
        );
      } else if (control !== undefined && formControls.isRetired(control)) {
        retired.push(
          `authSchema param "${field.name}": control "${control}" was ` +
            `retired in plugin API v${formControls.get(control).retiredIn} — ` +
            `it still works (the engine builds and validates it as ` +
            `"${formControls.resolve(control)}" forever), but a new game ` +
            `should declare "${formControls.resolve(control)}" itself`,
        );
      }

      // `source` резолвится вызывающей стороной через ctx.sources, а
      // auth-форма строится с ПУСТЫМ ctx (client/components/view/Auth.js) —
      // значит список вариантов у такого поля пуст всегда: игрок видит
      // 'no options available' и войти не может, а хост отвергает любое
      // значение как не-вариант. Это только для authSchema; в roomForm
      // (правило B5) source штатный — там движок отдаёт каталог карт
      if (field.options?.source !== undefined) {
        violations.push(
          `authSchema param "${field.name}" declares options.source ` +
            `"${field.options.source}" — the auth form is built without ` +
            'sources, so the field resolves to an empty list and nobody can ' +
            'log in; inline the options',
        );
      }

      const validatorName = field.options?.validator;

      // опечатка в имени (как и не-функция под верным именем) = поле не
      // проверяется никем: validateAuth пропускает нерезолвнутый валидатор
      // молча. Резолвер — тот же, которым зовёт хост (lib/validators.js),
      // чтобы правило не обещало того, чего не проверяет
      if (
        validatorName !== undefined &&
        !resolveValidator(validatorName, validators)
      ) {
        violations.push(
          `authSchema param "${field.name}" names validator ` +
            `"${validatorName}", which authSchema.validators does not ` +
            'provide as a function — the host skips the check silently',
        );
      }
    }

    if (!params.some(field => field.name === 'model')) {
      violations.push(
        'authSchema has no param named exactly "model" — the engine reads ' +
          'params.model when it creates the participant',
      );
    }

    // то же, что делает B5 для roomForm: выведенный контрол — не отказ, а
    // предупреждение, иначе правило отвергало бы игру за возраст (И1)
    if (violations.length === 0 && retired.length > 0) {
      return verdict(
        retired,
        'retired controls still build and validate, via aliases',
        WARN,
      );
    }

    return verdict(violations);
  },
};
