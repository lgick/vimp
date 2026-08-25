import { ERROR, skip, verdict } from '../result.js';
import { resolveValidator } from '../../../lib/validators.js';

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
    'authSchema: fieldsId, no nickname field, the model field, resolvable ' +
    'validators',

  check(ctx) {
    if (!ctx.authSchema) {
      return skip('no HostPlugin.authSchema');
    }

    const { elems = {}, params = [] } = ctx.authSchema;
    const violations = [];

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

    return verdict(violations);
  },
};
