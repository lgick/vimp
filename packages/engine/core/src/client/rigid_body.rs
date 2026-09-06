//! Минимальный двухтельный решатель контактов (sequential impulse) для
//! клиентского предсказания — порт src/lib/rigidBody.js (срез tank-battle
//! 2026-08): предсказанный актор, динамика карты и стены живут в одной
//! симуляции, поэтому нарисованные тела не выдавливают друг друга.
//! Это приближение Rapier, а не его копия: остаток расхождения прячет
//! реконсиляция игрового предиктора.
//!
//! Здесь же — материальные свойства контакта (`MAP_SURFACE`,
//! `combine_surfaces`) и масс-инерционные свойства прямоугольного тела
//! (`box_mass_properties`): их обязаны видеть одинаково обе стороны, иначе
//! реплика тихо разъедется с хостом.
//!
//! `Body::x`/`y` — ЦЕНТР бокса, не «угол объекта» снапшота
//! (см. `client::collision::box_center_from_origin`).
//! Статика (стена) — `inv_mass: 0.0, inv_inertia: 0.0`.

use super::collision::Contact;
use crate::map::{DEFAULT_FRICTION, DEFAULT_RESTITUTION};
use crate::physics::{clamp, normalize_angle};

/// Материальные свойства поверхности.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Surface {
    pub friction: f32,
    pub restitution: f32,
}

/// Поверхность геометрии карты (стены и динамика) — те же дефолты
/// коллайдеров, с которыми хост строит карту (`map.rs`).
pub const MAP_SURFACE: Surface = Surface {
    friction: DEFAULT_FRICTION,
    restitution: DEFAULT_RESTITUTION,
};

/// Тело клиентской реплики.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Body {
    pub x: f32,
    pub y: f32,
    pub angle: f32,
    pub vx: f32,
    pub vy: f32,
    pub angvel: f32,
    pub inv_mass: f32,
    pub inv_inertia: f32,
    pub linear_damping: f32,
    pub angular_damping: f32,
}

impl Default for Body {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            angle: 0.0,
            vx: 0.0,
            vy: 0.0,
            angvel: 0.0,
            inv_mass: 0.0,
            inv_inertia: 0.0,
            linear_damping: 0.0,
            angular_damping: 0.0,
        }
    }
}

/// Обратные масса и момент инерции прямоугольного тела.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MassProperties {
    pub inv_mass: f32,
    pub inv_inertia: f32,
}

/// Комбинирует материальные свойства двух тел в параметры контакта.
/// Rapier сводит коэффициенты правилом среднего
/// (`CoefficientCombineRule::Average`) — реплика делает так же.
pub fn combine_surfaces(a: &Surface, b: &Surface) -> Surface {
    Surface {
        friction: (a.friction + b.friction) / 2.0,
        restitution: (a.restitution + b.restitution) / 2.0,
    }
}

/// Обратные масса и момент инерции прямоугольника.
/// Нулевая плотность или габарит дают статику (нулевые обратные величины),
/// а не деление на ноль.
pub fn box_mass_properties(width: f32, height: f32, density: f32) -> MassProperties {
    let mass = density * width * height;
    let inertia = (mass * (width * width + height * height)) / 12.0;

    MassProperties {
        inv_mass: if mass > 0.0 { 1.0 / mass } else { 0.0 },
        inv_inertia: if inertia > 0.0 { 1.0 / inertia } else { 0.0 },
    }
}

/// Один шаг интеграции тела.
/// Порядок обязан совпадать с шагом игрового предиктора: позиция
/// интегрируется скоростью ДО демпфирования, хранится задемпфированная
/// скорость. Порядок эмпирический, повторяет Rapier.
pub fn integrate(body: &mut Body, dt: f32) {
    body.x += body.vx * dt;
    body.y += body.vy * dt;
    body.angle = normalize_angle(body.angle + body.angvel * dt);

    let linear = 1.0 / (1.0 + dt * body.linear_damping);
    let angular = 1.0 / (1.0 + dt * body.angular_damping);

    body.vx *= linear;
    body.vy *= linear;
    body.angvel *= angular;
}

/// Разводит тела на глубину проникновения пропорционально обратным массам.
/// Вызывается ОДИН раз на контакт за шаг: повторное применение той же глубины
/// на каждой итерации решателя расталкивало бы тела кратно числу итераций.
/// Нормаль контакта направлена ОТ тела `a`.
/// Спекулятивный контакт (`depth < 0`, тела ещё разведены) позиций не
/// трогает: разводить нечего, его дело — импульс.
pub fn separate_bodies(a: &mut Body, b: &mut Body, contact: &Contact) {
    let total = a.inv_mass + b.inv_mass;

    // два статических тела — разводить нечего
    if total == 0.0 || contact.depth <= 0.0 {
        return;
    }

    a.x -= (contact.nx * contact.depth * a.inv_mass) / total;
    a.y -= (contact.ny * contact.depth * a.inv_mass) / total;
    b.x += (contact.nx * contact.depth * b.inv_mass) / total;
    b.y += (contact.ny * contact.depth * b.inv_mass) / total;
}

/// Накопленные за шаг импульсы одного контакта. Решатель проходит по
/// контактам несколько раз, и клампится НАКОПЛЕННАЯ величина, а не приращение
/// итерации: иначе первая же точка манифольда забирает весь нормальный
/// импульс себе, разворачивает корпус плечом и следующая точка уже
/// расходится — исправить это приращением решателю нечем. Так же устроен
/// решатель Rapier, и без накопления реплика разъезжалась с ним на
/// касательных ударах вдвое по `angvel`.
#[derive(Clone, Copy, Debug, Default)]
pub struct ContactImpulses {
    /// суммарный нормальный импульс (неотрицателен: контакт не притягивает)
    pub normal: f32,
    /// суммарный касательный импульс (зажат конусом Кулона)
    pub tangent: f32,
    // целевая скорость отскока, снятая на ПЕРВОЙ итерации: пересчёт на
    // каждой множил бы восстановление
    bounce: f32,
    started: bool,
}

/// Нормальный импульс с отскоком плюс кулоновское трение по касательной.
/// Итерируется решателем (sequential impulse) по всем контактам шага; `acc`
/// живёт от первой итерации до последней и обязан быть свой у каждого
/// контакта. Мутирует скорости обоих тел, позиций не трогает.
/// Нормаль контакта направлена ОТ тела `a`.
///
/// `dt` нужен спекулятивному контакту (`depth < 0`): зазор закрывается за
/// шаг со скоростью `-depth / dt`, и импульс гасит только то, что закрывает
/// зазор БЫСТРЕЕ. Тело, летящее в стену, останавливается У неё, а не внутри
/// (это и делает `soft_ccd_prediction` у хоста). Восстановление
/// (`restitution`) считается от того же избытка, иначе тело отскочило бы,
/// не коснувшись. При `depth >= 0` поправка нулевая — прежнее поведение.
pub fn apply_contact_impulse(
    a: &mut Body,
    b: &mut Body,
    contact: &Contact,
    surface: &Surface,
    dt: f32,
    acc: &mut ContactImpulses,
) {
    let Contact { nx, ny, cx, cy, .. } = *contact;

    if a.inv_mass + b.inv_mass == 0.0 {
        return;
    }

    // плечи от центров тел до точки контакта
    let rax = cx - a.x;
    let ray = cy - a.y;
    let rbx = cx - b.x;
    let rby = cy - b.y;

    let rn_a = rax * ny - ray * nx;
    let rn_b = rbx * ny - rby * nx;
    let eff_n = a.inv_mass + b.inv_mass + rn_a * rn_a * a.inv_inertia + rn_b * rn_b * b.inv_inertia;

    if eff_n == 0.0 {
        return;
    }

    // скорость закрытия зазора за шаг: на проникновении — ноль
    let bias = if contact.depth < 0.0 && dt > 0.0 {
        -contact.depth / dt
    } else {
        0.0
    };

    let closing = normal_velocity(a, b, rax, ray, rbx, rby, nx, ny) + bias;

    if !acc.started {
        acc.started = true;
        acc.bounce = surface.restitution * closing.min(0.0);
    }

    // клампится НАКОПЛЕННЫЙ импульс: приращение может быть отрицательным,
    // пока сумма неотрицательна — так решатель забирает у первой точки
    // манифольда лишнее, отданное ей на прошлой итерации
    let total = (acc.normal - (closing + acc.bounce) / eff_n).max(0.0);
    let jn = total - acc.normal;

    acc.normal = total;

    a.vx -= nx * jn * a.inv_mass;
    a.vy -= ny * jn * a.inv_mass;
    a.angvel -= rn_a * jn * a.inv_inertia;
    b.vx += nx * jn * b.inv_mass;
    b.vy += ny * jn * b.inv_mass;
    b.angvel += rn_b * jn * b.inv_inertia;

    // трение по касательной, зажатое кулоновским конусом от НАКОПЛЕННОГО
    // нормального импульса и посчитанное по скоростям ПОСЛЕ него
    let tx = -ny;
    let ty = nx;
    let rt_a = rax * ty - ray * tx;
    let rt_b = rbx * ty - rby * tx;
    let eff_t = a.inv_mass + b.inv_mass + rt_a * rt_a * a.inv_inertia + rt_b * rt_b * b.inv_inertia;

    if eff_t == 0.0 {
        return;
    }

    let vt = normal_velocity(a, b, rax, ray, rbx, rby, tx, ty);
    let max_friction = surface.friction * acc.normal;
    let clamped = clamp(acc.tangent - vt / eff_t, -max_friction, max_friction);
    let jt = clamped - acc.tangent;

    acc.tangent = clamped;

    a.vx -= tx * jt * a.inv_mass;
    a.vy -= ty * jt * a.inv_mass;
    a.angvel -= rt_a * jt * a.inv_inertia;
    b.vx += tx * jt * b.inv_mass;
    b.vy += ty * jt * b.inv_mass;
    b.angvel += rt_b * jt * b.inv_inertia;
}

// относительная скорость точек контакта (v + ω × r) вдоль оси (nx, ny)
#[allow(clippy::too_many_arguments)]
fn normal_velocity(
    a: &Body,
    b: &Body,
    rax: f32,
    ray: f32,
    rbx: f32,
    rby: f32,
    nx: f32,
    ny: f32,
) -> f32 {
    let vax = a.vx - a.angvel * ray;
    let vay = a.vy + a.angvel * rax;
    let vbx = b.vx - b.angvel * rby;
    let vby = b.vy + b.angvel * rbx;

    (vbx - vax) * nx + (vby - vay) * ny
}

#[cfg(test)]
mod tests {
    use super::*;

    const DT: f32 = 1.0 / 120.0;

    // разрешение одиночного контакта ровно в том порядке, в каком его делает
    // решатель игрового предиктора
    fn resolve_contact(a: &mut Body, b: &mut Body, contact: &Contact, surface: &Surface) {
        separate_bodies(a, b, contact);
        apply_contact_impulse(a, b, contact, surface, DT, &mut ContactImpulses::default());
    }

    fn body() -> Body {
        Body {
            inv_mass: 1.0,
            inv_inertia: 1.0,
            ..Body::default()
        }
    }

    fn static_body() -> Body {
        Body::default()
    }

    fn smooth(restitution: f32) -> Surface {
        Surface {
            friction: 0.0,
            restitution,
        }
    }

    // лобовой контакт по X: точка контакта на линии центров, плеча нет
    fn head_on() -> Contact {
        Contact {
            nx: 1.0,
            ny: 0.0,
            depth: 2.0,
            cx: 5.0,
            cy: 0.0,
        }
    }

    #[test]
    fn integrate_moves_by_undamped_velocity() {
        let dt = 1.0 / 120.0;
        let mut b = Body {
            vx: 100.0,
            vy: -40.0,
            angvel: 2.0,
            linear_damping: 3.0,
            angular_damping: 100.0,
            ..body()
        };

        integrate(&mut b, dt);

        // позиция интегрируется скоростью ДО демпфирования
        assert!((b.x - 100.0 * dt).abs() < 1e-6);
        assert!((b.y + 40.0 * dt).abs() < 1e-6);
        assert!((b.angle - 2.0 * dt).abs() < 1e-6);

        // хранится уже задемпфированная скорость
        assert!((b.vx - 100.0 / (1.0 + dt * 3.0)).abs() < 1e-4);
        assert!((b.vy + 40.0 / (1.0 + dt * 3.0)).abs() < 1e-4);
        assert!((b.angvel - 2.0 / (1.0 + dt * 100.0)).abs() < 1e-6);
    }

    #[test]
    fn integrate_normalizes_the_angle() {
        let mut b = Body {
            angle: 3.1,
            angvel: 10.0,
            ..body()
        };

        integrate(&mut b, 0.1);

        assert!(b.angle >= -core::f32::consts::PI);
        assert!(b.angle <= core::f32::consts::PI);
    }

    #[test]
    fn zero_damping_keeps_velocity() {
        let mut b = Body {
            vx: 7.0,
            angvel: 3.0,
            ..body()
        };

        integrate(&mut b, 0.5);

        assert_eq!(b.vx, 7.0);
        assert_eq!(b.angvel, 3.0);
    }

    #[test]
    fn equal_bodies_conserve_momentum() {
        let mut a = Body { vx: 10.0, ..body() };
        let mut b = Body { x: 8.0, ..body() };
        let before = a.vx + b.vx;

        resolve_contact(&mut a, &mut b, &head_on(), &smooth(0.0));

        assert!((a.vx + b.vx - before).abs() < 1e-5);
    }

    #[test]
    fn restitution_zero_kills_the_closing_velocity() {
        let mut a = Body { vx: 10.0, ..body() };
        let mut b = Body { x: 8.0, ..body() };

        resolve_contact(&mut a, &mut b, &head_on(), &smooth(0.0));

        assert!((b.vx - a.vx).abs() < 1e-5);
    }

    #[test]
    fn restitution_one_swaps_velocities() {
        let mut a = Body { vx: 10.0, ..body() };
        let mut b = Body { x: 8.0, ..body() };

        resolve_contact(&mut a, &mut b, &head_on(), &smooth(1.0));

        assert!(a.vx.abs() < 1e-5);
        assert!((b.vx - 10.0).abs() < 1e-5);
    }

    #[test]
    fn static_body_neither_moves_nor_accelerates() {
        let mut a = Body { vx: 10.0, ..body() };
        let mut wall = Body {
            x: 8.0,
            ..static_body()
        };

        resolve_contact(&mut a, &mut wall, &head_on(), &smooth(0.0));

        assert_eq!(wall.x, 8.0);
        assert_eq!(wall.vx, 0.0);
        assert_eq!(wall.angvel, 0.0);

        // всё выталкивание досталось подвижному телу
        assert!((a.x + 2.0).abs() < 1e-5);
        assert!(a.vx.abs() < 1e-5);
    }

    #[test]
    fn two_static_bodies_are_a_no_op() {
        let mut a = static_body();
        let mut b = Body {
            x: 8.0,
            ..static_body()
        };

        resolve_contact(&mut a, &mut b, &head_on(), &smooth(0.0));

        assert_eq!(a, static_body());
    }

    #[test]
    fn separating_bodies_get_position_correction_but_no_impulse() {
        let mut a = Body { vx: -5.0, ..body() };
        let mut b = Body {
            x: 8.0,
            vx: 5.0,
            ..body()
        };

        resolve_contact(&mut a, &mut b, &head_on(), &smooth(0.0));

        assert_eq!(a.vx, -5.0);
        assert_eq!(b.vx, 5.0);
        // позиционная коррекция делится поровну между равными массами
        assert!((a.x + 1.0).abs() < 1e-5);
        assert!((b.x - 9.0).abs() < 1e-5);
    }

    #[test]
    fn position_correction_scales_with_inverse_mass() {
        let mut light = Body {
            inv_mass: 4.0,
            ..body()
        };
        let mut heavy = Body { x: 8.0, ..body() };

        resolve_contact(&mut light, &mut heavy, &head_on(), &smooth(0.0));

        // лёгкое тело уезжает вчетверо дальше тяжёлого
        assert!((light.x + 1.6).abs() < 1e-5);
        assert!((heavy.x - 8.4).abs() < 1e-5);
    }

    #[test]
    fn friction_is_clamped_by_the_coulomb_cone() {
        // сильное касательное движение при слабом нормальном сближении
        let contact = Contact {
            depth: 0.1,
            ..head_on()
        };
        let mut a = Body {
            vx: 1.0,
            vy: 100.0,
            inv_inertia: 0.0,
            ..body()
        };
        let mut b = Body {
            x: 8.0,
            inv_inertia: 0.0,
            ..body()
        };

        resolve_contact(
            &mut a,
            &mut b,
            &contact,
            &Surface {
                friction: 0.2,
                restitution: 0.0,
            },
        );

        // нормальный импульс равных масс: jn = -vn / (im + im) = 0.5
        let jn = 0.5;

        assert!(b.vy.abs() <= 0.2 * jn + 1e-6);
        assert!(b.vy > 0.0);
    }

    #[test]
    fn zero_friction_keeps_the_tangential_velocity() {
        let contact = Contact {
            depth: 0.1,
            ..head_on()
        };
        let mut a = Body {
            vx: 1.0,
            vy: 100.0,
            inv_inertia: 0.0,
            ..body()
        };
        let mut b = Body {
            x: 8.0,
            inv_inertia: 0.0,
            ..body()
        };

        resolve_contact(&mut a, &mut b, &contact, &smooth(0.0));

        assert_eq!(b.vy, 0.0);
        assert_eq!(a.vy, 100.0);
    }

    #[test]
    fn off_center_hit_spins_both_bodies() {
        // контакт смещён по Y — появляется плечо
        let contact = Contact {
            depth: 1.0,
            cy: 4.0,
            ..head_on()
        };
        let mut a = Body { vx: 10.0, ..body() };
        let mut b = Body { x: 8.0, ..body() };

        resolve_contact(&mut a, &mut b, &contact, &smooth(0.0));

        assert_ne!(a.angvel, 0.0);
        assert_ne!(b.angvel, 0.0);
    }

    #[test]
    fn head_on_hit_does_not_spin() {
        let contact = Contact {
            depth: 1.0,
            ..head_on()
        };
        let mut a = Body { vx: 10.0, ..body() };
        let mut b = Body { x: 8.0, ..body() };

        resolve_contact(&mut a, &mut b, &contact, &smooth(0.0));

        assert!(a.angvel.abs() < 1e-6);
        assert!(b.angvel.abs() < 1e-6);
    }

    #[test]
    fn separate_bodies_touches_positions_only() {
        let mut a = Body { vx: 10.0, ..body() };
        let mut b = Body { x: 8.0, ..body() };

        separate_bodies(&mut a, &mut b, &head_on());

        assert!((a.x + 1.0).abs() < 1e-6);
        assert!((b.x - 9.0).abs() < 1e-6);
        assert_eq!(a.vx, 10.0);
        assert_eq!(b.vx, 0.0);
    }

    #[test]
    fn apply_contact_impulse_touches_velocities_only() {
        let mut a = Body { vx: 10.0, ..body() };
        let mut b = Body { x: 8.0, ..body() };

        apply_contact_impulse(&mut a, &mut b, &head_on(), &smooth(0.0), DT, &mut ContactImpulses::default());

        assert_eq!(a.x, 0.0);
        assert_eq!(b.x, 8.0);
        assert!((a.vx - 5.0).abs() < 1e-5);
        assert!((b.vx - 5.0).abs() < 1e-5);
    }

    // регресс: повтор развода на каждой итерации решателя расталкивал тела
    // кратно числу итераций — отсюда брался рывок рисуемой позиции
    #[test]
    fn solver_iterations_do_not_multiply_the_correction() {
        let mut a = Body { vx: 10.0, ..body() };
        let mut b = Body { x: 8.0, ..body() };

        separate_bodies(&mut a, &mut b, &head_on());

        let (ax, bx) = (a.x, b.x);

        for _ in 0..4 {
            apply_contact_impulse(&mut a, &mut b, &head_on(), &smooth(0.0), DT, &mut ContactImpulses::default());
        }

        assert_eq!(a.x, ax);
        assert_eq!(b.x, bx);
    }

    // — спекулятивный контакт (зазор) —

    // зазор 0.5 по x между телом и стеной
    fn speculative(depth: f32) -> Contact {
        Contact {
            nx: 1.0,
            ny: 0.0,
            depth,
            cx: 5.0,
            cy: 0.0,
        }
    }

    #[test]
    fn separate_bodies_ignores_a_gap() {
        let mut a = body();
        let mut b = static_body();

        separate_bodies(&mut a, &mut b, &speculative(-0.5));

        assert_eq!(a.x, 0.0, "разводить нечего — тела ещё не перекрыты");
        assert_eq!(b.x, 0.0);
    }

    #[test]
    fn a_gap_closed_slower_than_a_step_gets_no_impulse() {
        // зазор 0.5, за шаг тело проходит 0.5/2 — контакта в этом шаге нет
        let mut a = Body {
            vx: 0.5 / DT / 2.0,
            ..body()
        };
        let mut b = static_body();

        apply_contact_impulse(&mut a, &mut b, &speculative(-0.5), &smooth(0.0), DT, &mut ContactImpulses::default());

        assert!((a.vx - 0.5 / DT / 2.0).abs() < 1e-3, "импульс лишний");
    }

    #[test]
    fn a_body_flying_into_the_wall_stops_at_it() {
        // зазор 0.5, скорость закрывает его вчетверо быстрее шага: импульс
        // обязан оставить ровно ту скорость, что доводит тело до стены и
        // не дальше — иначе следующий шаг начнётся уже изнутри стены
        let gap = 0.5;
        let mut a = Body {
            vx: 4.0 * gap / DT,
            ..body()
        };
        let mut b = static_body();

        apply_contact_impulse(&mut a, &mut b, &speculative(-gap), &smooth(0.0), DT, &mut ContactImpulses::default());
        integrate(&mut a, DT);

        assert!(
            (a.x - gap).abs() < 1e-3,
            "тело обязано встать у стены, получено {}",
            a.x
        );
    }

    #[test]
    fn restitution_on_a_gap_bounces_only_the_excess() {
        // упругость применяется к ИЗБЫТКУ над скоростью закрытия зазора:
        // иначе тело отскочило бы на полной скорости, не коснувшись стены
        let gap = 0.5;
        let speed = 2.0 * gap / DT;
        let mut a = Body { vx: speed, ..body() };
        let mut b = static_body();

        apply_contact_impulse(&mut a, &mut b, &speculative(-gap), &smooth(1.0), DT, &mut ContactImpulses::default());

        // на контакте вплотную та же скорость развернулась бы целиком
        let mut flush = Body { vx: speed, ..body() };
        let mut wall = static_body();

        apply_contact_impulse(&mut flush, &mut wall, &speculative(0.0), &smooth(1.0), DT, &mut ContactImpulses::default());

        assert!((flush.vx + speed).abs() < 1e-2, "вплотную — полный отскок");
        // избыток = speed − gap/dt = gap/dt, разворот оставляет
        // (gap/dt) − 2·(gap/dt) = −gap/dt относительно точки касания,
        // то есть ровно ноль в мире
        assert!(a.vx.abs() < 1e-2, "получено {}", a.vx);
        assert!(a.vx > flush.vx, "зазор обязан смягчить отскок");
    }

    #[test]
    fn penetration_ignores_the_prediction_bias() {
        // depth > 0 — прежняя формула бит в бит, dt ни на что не влияет
        let mut a = Body { vx: 10.0, ..body() };
        let mut b = static_body();
        let mut a_other = a;
        let mut b_other = b;

        apply_contact_impulse(&mut a, &mut b, &head_on(), &smooth(0.0), DT, &mut ContactImpulses::default());
        apply_contact_impulse(&mut a_other, &mut b_other, &head_on(), &smooth(0.0), 1.0, &mut ContactImpulses::default());

        assert_eq!(a.vx, a_other.vx);
    }

    #[test]
    fn a_two_point_manifold_satisfies_both_points() {
        // манифольд грани, целиком лежащей по одну сторону от центра: без
        // накопления первая точка забирает весь импульс и разворачивает
        // корпус так, что вторая улетает от стены. С накоплением решатель
        // возвращает лишнее, и обе точки приходят к допустимому решению
        let point = |cy: f32| Contact {
            nx: 1.0,
            ny: 0.0,
            depth: 0.5,
            cx: 5.0,
            cy,
        };
        let contacts = [point(1.0), point(3.0)];
        let surface = smooth(0.0);
        let props = box_mass_properties(8.0, 6.0, 200.0);

        let mut a = Body {
            vx: 100.0,
            inv_mass: props.inv_mass,
            inv_inertia: props.inv_inertia,
            ..Body::default()
        };
        let mut wall = static_body();
        let mut acc = [ContactImpulses::default(); 2];

        for _ in 0..8 {
            for (contact, state) in contacts.iter().zip(acc.iter_mut()) {
                apply_contact_impulse(&mut a, &mut wall, contact, &surface, DT, state);
            }
        }

        for contact in &contacts {
            let vn = -(a.vx - a.angvel * (contact.cy - a.y));

            assert!(vn > -1e-3, "точка {} всё ещё сближается: {vn}", contact.cy);
        }
    }

    #[test]
    fn the_accumulated_impulse_can_be_given_back() {
        // это и отличает накопление от применения приращений: итерация,
        // увидевшая тело уже расходящимся, снимает лишнее, отданное на
        // прошлой, — но не уводит сумму ниже нуля (контакт не притягивает)
        let mut a = Body { vx: 100.0, ..body() };
        let mut wall = static_body();
        let mut acc = ContactImpulses::default();

        apply_contact_impulse(&mut a, &mut wall, &head_on(), &smooth(0.0), DT, &mut acc);

        let after_first = acc.normal;

        assert!(after_first > 0.0);

        // сторонняя сила расталкивает тела сильнее, чем нужно
        a.vx = -50.0;
        apply_contact_impulse(&mut a, &mut wall, &head_on(), &smooth(0.0), DT, &mut acc);

        assert!(acc.normal < after_first, "лишнее обязано вернуться");
        assert!(acc.normal >= 0.0, "контакт не притягивает");
    }

    #[test]
    fn rectangle_mass_and_inertia() {
        let props = box_mass_properties(8.0, 6.0, 200.0);
        let mass = 200.0 * 8.0 * 6.0;

        assert!((1.0 / props.inv_mass - mass).abs() < 1e-1);
        assert!((1.0 / props.inv_inertia - (mass * (64.0 + 36.0)) / 12.0).abs() < 1.0);
    }

    #[test]
    fn zero_density_or_size_is_static() {
        let zero = MassProperties {
            inv_mass: 0.0,
            inv_inertia: 0.0,
        };

        assert_eq!(box_mass_properties(8.0, 6.0, 0.0), zero);
        assert_eq!(box_mass_properties(0.0, 0.0, 200.0), zero);
    }

    #[test]
    fn surfaces_combine_by_the_average_rule() {
        let tank = Surface {
            friction: 0.5,
            restitution: 0.1,
        };

        assert_eq!(
            combine_surfaces(&tank, &MAP_SURFACE),
            Surface {
                friction: 0.35,
                restitution: 0.05,
            }
        );
    }
}
