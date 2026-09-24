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

use super::collision::{Contact, Manifold};
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
/// Паритета с хостом при контактах не даёт: хост интегрирует позы на
/// подшагах решателя — для этого есть `step_bodies`.
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

/// Допуск проникновения, который позиционная коррекция не трогает:
/// `IntegrationParameters::normalized_allowed_linear_error` Rapier,
/// умноженный на `length_unit`. Хост карту строит на параметрах по
/// умолчанию (`map::GameMap` правит только `dt`), поэтому `length_unit`
/// здесь единица.
pub const ALLOWED_LINEAR_ERROR: f32 = 0.001;

/// Предел скорости расталкивания, юнитов в секунду:
/// `normalized_max_corrective_velocity` Rapier на том же `length_unit`.
/// За шаг он даёт потолок коррекции `MAX_CORRECTIVE_VELOCITY * dt`.
pub const MAX_CORRECTIVE_VELOCITY: f32 = 10.0;

// контактная пружина Rapier (`SpringCoefficients::contact_defaults`):
// собственная частота в герцах и коэффициент затухания
const CONTACT_NATURAL_FREQUENCY: f32 = 30.0;
const CONTACT_DAMPING_RATIO: f32 = 5.0;

/// Доля проникновения, которую контактная пружина Rapier снимает за шаг
/// длиной `dt` (его `IntegrationParameters::erp`).
pub fn contact_erp(dt: f32) -> f32 {
    let angular_frequency = CONTACT_NATURAL_FREQUENCY * std::f32::consts::TAU;

    dt * angular_frequency / (dt * angular_frequency + 2.0 * CONTACT_DAMPING_RATIO)
}

/// Насколько тела разводятся за ОДИН шаг при проникновении `depth`.
/// Это закон Rapier, а не полная глубина: у него позиционная ошибка
/// снимается смещением `rhs_bias` контактного ограничения —
/// `clamp(erp_inv_dt * (depth - allowed_error), 0, max_corrective_velocity)`,
/// то есть за шаг уходит лишь часть перекрытия, и не быстрее потолка.
/// Реплика обязана растаскивать тела так же: выталкивание на всю глубину за
/// один шаг давало рывок на несколько юнитов там, где хост расходился на
/// доли (глубокое перекрытие — упавший на ящик танк), и предсказание
/// пробивало порог расхождения.
/// Зазор (`depth <= 0`) и нулевой шаг коррекции не дают вовсе.
pub fn penetration_correction(depth: f32, dt: f32) -> f32 {
    let excess = depth - ALLOWED_LINEAR_ERROR;

    if excess <= 0.0 || dt <= 0.0 {
        return 0.0;
    }

    (contact_erp(dt) * excess).min(MAX_CORRECTIVE_VELOCITY * dt)
}

/// Разводит тела пропорционально обратным массам на ту часть проникновения,
/// которую за шаг снимает контактная пружина хоста
/// (`penetration_correction`).
/// Вызывается ОДИН раз на контакт за шаг: повторное применение той же глубины
/// на каждой итерации решателя расталкивало бы тела кратно числу итераций.
/// Нормаль контакта направлена ОТ тела `a`.
/// Спекулятивный контакт (`depth < 0`, тела ещё разведены) позиций не
/// трогает: разводить нечего, его дело — импульс.
/// Для паритета с хостом — `step_bodies`: там проникновение снимает мягкая
/// пружина на каждом подшаге.
pub fn separate_bodies(a: &mut Body, b: &mut Body, contact: &Contact, dt: f32) {
    let total = a.inv_mass + b.inv_mass;
    let correction = penetration_correction(contact.depth, dt);

    // два статических тела — разводить нечего
    if total == 0.0 || correction == 0.0 {
        return;
    }

    a.x -= (contact.nx * correction * a.inv_mass) / total;
    a.y -= (contact.ny * correction * a.inv_mass) / total;
    b.x += (contact.nx * correction * b.inv_mass) / total;
    b.y += (contact.ny * correction * b.inv_mass) / total;
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
///
/// Паритета с хостом на ударе этот решатель не даёт: хост решает контакт на
/// подшагах с проходом без смещения и помнит точки между шагами — это
/// повторяет `step_bodies`. Функция остаётся для совместимости.
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

// ***** шаг тел как у Rapier ***** //

/// Число подшагов решателя хоста: `IntegrationParameters::num_solver_iterations`
/// Rapier по умолчанию. Шаг `step_bodies` делится на столько подшагов.
pub const SOLVER_SUBSTEPS: usize = 4;

/// Устойчивый между шагами идентификатор точки контакта: по нему
/// `step_bodies` находит память точки с прошлого шага (`is_new`, warmstart) —
/// то, что parry у хоста ведёт в `ContactData` точки манифольда.
/// Индексы среза `bodies` для ключа не годятся: вызывающий пересобирает срез
/// каждый шаг, и тот же партнёр получает другой индекс.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ContactKey {
    a: u32,
    b: u32,
    point: u8,
}

impl ContactKey {
    /// Ключ точки `point` пары `a`—`b`; `a`, `b` — устойчивые имена тел у
    /// вызывающего (id игры, индекс блока), `point` — номер вершины падающей
    /// грани (0 или 1), его ставит `ContactRow::from_manifold`.
    pub fn new(a: u32, b: u32, point: u8) -> Self {
        Self { a, b, point }
    }
}

/// Строка контакта шага: тела по индексам среза `bodies`, точка манифольда на
/// позе начала шага (нормаль от `a` к `b`), материал пары, ключ точки.
/// Две точки одного манифольда идут в `rows` подряд — их решает блочный
/// решатель пары; пару он узнаёт по одинаковым телам и именам в ключах и
/// точкам 0, затем 1.
#[derive(Clone, Copy, Debug)]
pub struct ContactRow {
    pub a: usize,
    pub b: usize,
    pub contact: Contact,
    pub surface: Surface,
    pub key: ContactKey,
}

impl ContactRow {
    /// Строки манифольда пары `a`—`b` для `step_bodies`: точки
    /// `Manifold::solver_points` (середины, как у parry) подряд — пару точек
    /// решает блочный решатель, и разорвать её нельзя; ключ точки —
    /// `key_base` с номером вершины падающей грани, от которой она пришла
    /// (0 или 1): он не сдвигается, когда соседняя точка уходит за
    /// предсказание.
    pub fn from_manifold(
        a: usize,
        b: usize,
        manifold: &Manifold,
        surface: Surface,
        key_base: ContactKey,
    ) -> impl Iterator<Item = ContactRow> + '_ {
        manifold
            .solver_points()
            .zip(manifold.point_ids())
            .map(move |(contact, &point)| ContactRow {
                a,
                b,
                contact,
                surface,
                key: ContactKey { point, ..key_base },
            })
    }
}

// память одной точки с прошлого шага (`ContactData` точки у Rapier)
#[derive(Clone, Copy, Debug)]
struct ContactMemory {
    key: ContactKey,
    // импульсы последнего подшага — ими шаг начинается (warmstart)
    warmstart_normal: f32,
    warmstart_tangent: f32,
    // нормальный импульс за весь шаг: ноль — точка на следующем шаге новая
    total_normal: f32,
}

/// Память контактов между шагами — то, что Rapier хранит в `ContactData`
/// точки: импульсы последнего подшага (warmstart, нормаль и касательная) и
/// сумма нормального импульса за шаг (по ней решается `is_new`, а с ним и
/// отскок). Вызывающий держит один кэш на симуляцию; в установившемся режиме
/// шаг не аллоцирует. `Clone` дешёвый — копируется только память точек:
/// предиктор хранит копию на каждый шаг в истории снимков и откатывает её
/// вместе с состоянием, иначе реплей у стены давал бы ложный отскок.
#[derive(Debug, Default)]
pub struct ContactCache {
    // память прошлого шага, отсортирована по ключу
    memory: Vec<ContactMemory>,
    // буферы шага: переиспользуются, в копию не входят
    next: Vec<ContactMemory>,
    constraints: Vec<Constraint>,
}

impl Clone for ContactCache {
    fn clone(&self) -> Self {
        Self {
            memory: self.memory.clone(),
            next: Vec::new(),
            constraints: Vec::new(),
        }
    }
}

impl ContactCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Забыть всё: телепорт, респаун, откат к снапшоту без сохранённого кэша.
    pub fn clear(&mut self) {
        self.memory.clear();
    }

    fn recall(&self, key: ContactKey) -> Option<&ContactMemory> {
        self.memory
            .binary_search_by(|memory| memory.key.cmp(&key))
            .ok()
            .map(|index| &self.memory[index])
    }
}

// одна строка ограничения: нормальная или касательная
// (`ContactConstraintNormalPart` / `ContactConstraintTangentPart` Rapier)
#[derive(Clone, Copy, Debug, Default)]
struct ConstraintPart {
    torque_a: f32,
    torque_b: f32,
    ii_torque_a: f32,
    ii_torque_b: f32,
    // проекционная масса
    r: f32,
    rhs: f32,
    rhs_wo_bias: f32,
    // импульс текущего подшага и сумма прошлых подшагов шага
    impulse: f32,
    accumulator: f32,
}

// ограничение одной точки (`ContactWithCoulombFriction` Rapier для одной
// точки манифольда)
#[derive(Clone, Copy, Debug)]
struct Constraint {
    a: usize,
    b: usize,
    key: ContactKey,
    // направление силы на тело `a` — минус нормаль (`dir1` Rapier)
    dir: [f32; 2],
    tangent: [f32; 2],
    // точка контакта в локальных фреймах тел: по ним пересчитывается зазор
    local_a: [f32; 2],
    local_b: [f32; 2],
    // зазор на начало шага (`dist` Rapier: > 0 — тела разведены)
    dist: f32,
    // целевая скорость отскока (`normal_vel` Rapier)
    normal_vel: f32,
    friction: f32,
    normal: ConstraintPart,
    tangential: ConstraintPart,
    // вторая точка манифольда той же пары идёт следом: блок 2×2
    pair_first: bool,
    // элементы блока (`r_mat_elts` Rapier): у первой точки — диагональ
    // обращённой матрицы, у второй — её внедиагональный элемент и
    // внедиагональный элемент необращённой
    r_mat: [f32; 2],
}

// наибольшее число обусловленности блока 2×2 двух точек манифольда
// (`k_maxConditionNumber` Box2D): хуже — точки считаются дублем
const MAX_BLOCK_CONDITION: f32 = 1000.0;

// `utils::simd_inv` Rapier: обратная величина, ноль у вырожденной
fn inv(value: f32) -> f32 {
    if (-1.0e-20..=1.0e-20).contains(&value) {
        0.0
    } else {
        1.0 / value
    }
}

fn cross(a: [f32; 2], b: [f32; 2]) -> f32 {
    a[0] * b[1] - a[1] * b[0]
}

fn dot(a: [f32; 2], b: [f32; 2]) -> f32 {
    a[0] * b[0] + a[1] * b[1]
}

fn is_static(body: &Body) -> bool {
    body.inv_mass == 0.0 && body.inv_inertia == 0.0
}

// точка тела из локального фрейма в мир и обратно
fn to_world(body: &Body, local: [f32; 2]) -> [f32; 2] {
    let (sin, cos) = body.angle.sin_cos();

    [
        body.x + cos * local[0] - sin * local[1],
        body.y + sin * local[0] + cos * local[1],
    ]
}

fn to_local(body: &Body, point: [f32; 2]) -> [f32; 2] {
    let (sin, cos) = body.angle.sin_cos();
    let dx = point[0] - body.x;
    let dy = point[1] - body.y;

    [cos * dx + sin * dy, -sin * dx + cos * dy]
}

// скорость точки тела, заданной плечом от центра
fn point_velocity(body: &Body, arm: [f32; 2]) -> [f32; 2] {
    [body.vx - body.angvel * arm[1], body.vy + body.angvel * arm[0]]
}

// `IntegrationParameters::erp_inv_dt` Rapier для шага `dt`
fn contact_erp_inv_dt(dt: f32) -> f32 {
    let angular_frequency = CONTACT_NATURAL_FREQUENCY * std::f32::consts::TAU;

    angular_frequency / (dt * angular_frequency + 2.0 * CONTACT_DAMPING_RATIO)
}

// `IntegrationParameters::cfm_factor` Rapier: мягкость прохода со смещением
fn contact_cfm_factor(dt: f32) -> f32 {
    let erp = dt * contact_erp_inv_dt(dt);

    if erp == 0.0 {
        return 1.0;
    }

    let inv_erp_minus_one = 1.0 / erp - 1.0;
    let cfm_coeff = inv_erp_minus_one * inv_erp_minus_one
        / ((1.0 + inv_erp_minus_one) * 4.0 * CONTACT_DAMPING_RATIO * CONTACT_DAMPING_RATIO);

    1.0 / (1.0 + cfm_coeff)
}

// строка ограничения вдоль направления `dir` с плечами точки
fn constraint_part(a: &Body, b: &Body, arm_a: [f32; 2], arm_b: [f32; 2], dir: [f32; 2]) -> ConstraintPart {
    let torque_a = cross(arm_a, dir);
    let torque_b = cross(arm_b, [-dir[0], -dir[1]]);
    let ii_torque_a = a.inv_inertia * torque_a;
    let ii_torque_b = b.inv_inertia * torque_b;

    ConstraintPart {
        torque_a,
        torque_b,
        ii_torque_a,
        ii_torque_b,
        r: inv(a.inv_mass + b.inv_mass + ii_torque_a * torque_a + ii_torque_b * torque_b),
        ..ConstraintPart::default()
    }
}

// построение ограничений на позе начала шага
// (`ContactWithCoulombFrictionBuilder::generate` Rapier)
fn build_constraints(bodies: &[Body], rows: &[ContactRow], cache: &ContactCache, out: &mut Vec<Constraint>) {
    for row in rows {
        let a = &bodies[row.a];
        let b = &bodies[row.b];

        // пара статики — Rapier ограничения не строит
        if is_static(a) && is_static(b) {
            continue;
        }

        let Contact { nx, ny, depth, cx, cy } = row.contact;
        let dir = [-nx, -ny];
        let tangent = [-dir[1], dir[0]];
        let point = [cx, cy];
        let arm_a = [cx - a.x, cy - a.y];
        let arm_b = [cx - b.x, cy - b.y];
        let vel_a = point_velocity(a, arm_a);
        let vel_b = point_velocity(b, arm_b);
        // < 0 — точки сближаются
        let projected_velocity = dot([vel_a[0] - vel_b[0], vel_a[1] - vel_b[1]], dir);

        let memory = cache.recall(row.key);
        let is_new = memory.is_none_or(|memory| memory.total_normal == 0.0);
        let restitution = row.surface.restitution;
        // `SolverContact::is_bouncy`: новая точка отскакивает при любой
        // упругости, уже толкавшая — только при e ≥ 1
        let is_bouncy = if is_new { restitution > 0.0 } else { restitution >= 1.0 };

        let mut normal = constraint_part(a, b, arm_a, arm_b, dir);
        let mut tangential = constraint_part(a, b, arm_a, arm_b, tangent);

        normal.impulse = memory.map_or(0.0, |memory| memory.warmstart_normal);
        tangential.impulse = memory.map_or(0.0, |memory| memory.warmstart_tangent);

        out.push(Constraint {
            a: row.a,
            b: row.b,
            key: row.key,
            dir,
            tangent,
            local_a: to_local(a, point),
            local_b: to_local(b, point),
            dist: -depth,
            normal_vel: if is_bouncy { restitution * projected_velocity } else { 0.0 },
            friction: row.surface.friction,
            normal,
            tangential,
            pair_first: false,
            r_mat: [0.0; 2],
        });
    }

    // две точки одного манифольда подряд — блок 2×2 (в 2D Rapier решает их
    // совместно, `BLOCK_SOLVER_ENABLED`); вырожденный блок — «лишняя» точка
    // не толкает вовсе, как в `generate`. Блок — только внутри манифольда:
    // совпадения индексов тел мало (у вызывающего все стены могут быть одним
    // телом среза), нужны те же имена пары в ключах и точки 0, затем 1
    let mut index = 0;

    while index + 1 < out.len() {
        let (first, second) = (out[index], out[index + 1]);

        let one_manifold = first.a == second.a
            && first.b == second.b
            && first.key.a == second.key.a
            && first.key.b == second.key.b
            && first.key.point == 0
            && second.key.point == 1;

        if !one_manifold {
            index += 1;
            continue;
        }

        let a = &bodies[first.a];
        let b = &bodies[first.b];
        let m11 = inv(first.normal.r);
        let m22 = inv(second.normal.r);
        let m12 = a.inv_mass
            + b.inv_mass
            + first.normal.ii_torque_a * second.normal.torque_a
            + first.normal.ii_torque_b * second.normal.torque_b;
        let determinant = m11 * m22 - m12 * m12;
        // Rapier проверяет только `determinant > 0`. Точки в микронах друг
        // от друга дают блок, вырожденный лишь до округления f32: его
        // обращение в миллионы раз больше массы точки, и пара накачивает
        // энергию вплоть до inf/NaN. Плохо обусловленный блок решается как
        // вырожденный — лишняя точка не толкает (порог Box2D)
        let invertible = determinant > 0.0 && m11 * m11 < MAX_BLOCK_CONDITION * determinant;

        out[index].pair_first = true;
        out[index].r_mat = if invertible {
            [m22 / determinant, m11 / determinant]
        } else {
            [first.normal.r, 0.0]
        };
        out[index + 1].r_mat = if invertible {
            [-m12 / determinant, m12]
        } else {
            [0.0, 0.0]
        };

        index += 2;
    }
}

// пересчёт правых частей по текущим позам (`update` Rapier)
fn update_constraint(constraint: &mut Constraint, bodies: &[Body], h: f32, erp_inv_dt: f32) {
    let p_a = to_world(&bodies[constraint.a], constraint.local_a);
    let p_b = to_world(&bodies[constraint.b], constraint.local_b);
    let drift = [p_a[0] - p_b[0], p_a[1] - p_b[1]];
    let dist = constraint.dist + dot(drift, constraint.dir);

    let normal = &mut constraint.normal;
    let rhs_wo_bias = constraint.normal_vel + dist.max(0.0) / h;
    let rhs_bias = ((dist + ALLOWED_LINEAR_ERROR) * erp_inv_dt).clamp(-MAX_CORRECTIVE_VELOCITY, 0.0);

    normal.rhs_wo_bias = rhs_wo_bias;
    normal.rhs = rhs_wo_bias + rhs_bias;
    normal.accumulator += normal.impulse;

    let tangential = &mut constraint.tangential;

    tangential.accumulator += tangential.impulse;
    tangential.rhs_wo_bias = 0.0;
    tangential.rhs = dot(drift, constraint.tangent) / h;
}

// импульс `impulse` вдоль `dir` строки `part` в скорости обоих тел
fn apply_part(bodies: &mut [Body], a: usize, b: usize, dir: [f32; 2], part: &ConstraintPart, impulse: f32) {
    let body = &mut bodies[a];

    body.vx += dir[0] * body.inv_mass * impulse;
    body.vy += dir[1] * body.inv_mass * impulse;
    body.angvel += part.ii_torque_a * impulse;

    let body = &mut bodies[b];

    body.vx -= dir[0] * body.inv_mass * impulse;
    body.vy -= dir[1] * body.inv_mass * impulse;
    body.angvel += part.ii_torque_b * impulse;
}

// относительная скорость строки плюс правая часть (`dvel` Rapier)
fn part_velocity(bodies: &[Body], a: usize, b: usize, dir: [f32; 2], part: &ConstraintPart) -> f32 {
    let body_a = &bodies[a];
    let body_b = &bodies[b];

    dir[0] * body_a.vx + dir[1] * body_a.vy + part.torque_a * body_a.angvel
        - dir[0] * body_b.vx
        - dir[1] * body_b.vy
        + part.torque_b * body_b.angvel
        + part.rhs
}

fn warmstart(constraint: &Constraint, bodies: &mut [Body]) {
    let (a, b) = (constraint.a, constraint.b);

    apply_part(bodies, a, b, constraint.dir, &constraint.normal, constraint.normal.impulse);
    apply_part(
        bodies,
        a,
        b,
        constraint.tangent,
        &constraint.tangential,
        constraint.tangential.impulse,
    );
}

fn solve_normal(constraint: &mut Constraint, bodies: &mut [Body], cfm: f32) {
    let (a, b, dir) = (constraint.a, constraint.b, constraint.dir);
    let part = &mut constraint.normal;
    let dvel = part_velocity(bodies, a, b, dir, part);
    let impulse = cfm * (part.impulse - part.r * dvel).max(0.0);
    let delta = impulse - part.impulse;

    part.impulse = impulse;
    apply_part(bodies, a, b, dir, part, delta);
}

// две точки манифольда совместно (`solve_pair` +
// `solve_mlcp_two_constraints` Rapier): из четырёх кандидатов — обе точки
// толкают, только первая, только вторая, ни одна — берётся первый
// допустимый
fn solve_normal_pair(pair: &mut [Constraint], bodies: &mut [Body], cfm: f32) {
    let [first, second] = pair else {
        unreachable!("блок пары — ровно две точки");
    };
    let (a, b, dir) = (first.a, first.b, first.dir);
    let dvel_a = part_velocity(bodies, a, b, dir, &first.normal);
    let dvel_b = part_velocity(bodies, a, b, dir, &second.normal);
    let prev = [first.normal.impulse, second.normal.impulse];
    let [m11, m22] = first.r_mat;
    let [m12, m_inv12] = second.r_mat;

    let both = [prev[0] - (m11 * dvel_a + m12 * dvel_b), prev[1] - (m12 * dvel_a + m22 * dvel_b)];
    let only_first = [prev[0] - first.normal.r * dvel_a, 0.0];
    let only_second = [0.0, prev[1] - second.normal.r * dvel_b];

    let impulse = if both[0] >= 0.0 && both[1] >= 0.0 {
        [both[0] * cfm, both[1] * cfm]
    } else if only_first[0] >= 0.0 && dvel_b + m_inv12 * only_first[0] >= 0.0 {
        [only_first[0] * cfm, 0.0]
    } else if only_second[1] >= 0.0 && dvel_a + m_inv12 * only_second[1] >= 0.0 {
        [0.0, only_second[1] * cfm]
    } else if dvel_a >= 0.0 && dvel_b >= 0.0 {
        [0.0, 0.0]
    } else {
        prev
    };

    first.normal.impulse = impulse[0];
    second.normal.impulse = impulse[1];
    apply_part(bodies, a, b, dir, &first.normal, impulse[0] - prev[0]);
    apply_part(bodies, a, b, dir, &second.normal, impulse[1] - prev[1]);
}

// трение: конус — от нормального импульса ТЕКУЩЕГО подшага
fn solve_friction(constraint: &mut Constraint, bodies: &mut [Body]) {
    let (a, b, tangent) = (constraint.a, constraint.b, constraint.tangent);
    let limit = constraint.friction * constraint.normal.impulse;
    let part = &mut constraint.tangential;
    let dvel = part_velocity(bodies, a, b, tangent, part);
    let impulse = (part.impulse - part.r * dvel).clamp(-limit, limit);
    let delta = impulse - part.impulse;

    part.impulse = impulse;
    apply_part(bodies, a, b, tangent, part, delta);
}

// один проход PGS: по каждому манифольду сначала нормали, потом трение
fn solve_constraints(constraints: &mut [Constraint], bodies: &mut [Body], cfm: f32) {
    let mut index = 0;

    while index < constraints.len() {
        let len = if constraints[index].pair_first { 2 } else { 1 };
        let group = &mut constraints[index..index + len];

        if len == 2 {
            solve_normal_pair(group, bodies, cfm);
        } else {
            solve_normal(&mut group[0], bodies, cfm);
        }

        for constraint in group.iter_mut() {
            solve_friction(constraint, bodies);
        }

        index += len;
    }
}

// правые части без смещения и без мягкости (`remove_bias` Rapier)
fn remove_bias(constraints: &mut [Constraint]) {
    for constraint in constraints {
        constraint.normal.rhs = constraint.normal.rhs_wo_bias;
        constraint.tangential.rhs = constraint.tangential.rhs_wo_bias;
    }
}

// интеграция позы на подшаг: поворот линеаризован, как у Rapier
// (`RigidBodyVelocity::integrate_linearized`)
fn integrate_pose(body: &mut Body, h: f32) {
    let (sin, cos) = body.angle.sin_cos();
    let turn = body.angvel * h;
    let new_cos = cos - turn * sin;
    let new_sin = sin + turn * cos;

    body.x += body.vx * h;
    body.y += body.vy * h;
    body.angle = normalize_angle(new_sin.atan2(new_cos));
}

/// Шаг тел с контактами, как у хоста (TGS-решатель Rapier 0.34:
/// `velocity_solver.rs::solve_constraints`,
/// `contact_with_coulomb_friction.rs`, `contact_constraint_element.rs`).
/// Ограничения строятся раз на позе начала шага, затем `SOLVER_SUBSTEPS`
/// подшагов длиной `h = dt / SOLVER_SUBSTEPS`: пересчёт зазора по текущим
/// позам → warmstart импульсами прошлого подшага → проход со смещением
/// (мягкая пружина снимает проникновение, зазор разрешает сближение со
/// скоростью `зазор / h`) → интеграция поз на `h` → проход без смещения
/// (цель — отскок новой точки). После подшагов скорость один раз
/// демпфируется на полный `dt`, как в `integrate`.
///
/// Итог зависит от того, на каком подшаге закрывается зазор: раньше
/// последнего — тело уходит от стены с отскоком `−e·v`, на последнем —
/// отскока нет, остаётся скорость закрытия остатка, а на следующем шаге
/// точка уже не новая и гасит её. Одного правила на весь шаг, как у
/// `apply_contact_impulse`, для этого не хватает.
///
/// Заменяет `separate_bodies` + итерации `apply_contact_impulse` +
/// `integrate`: на выходе у `bodies` — позы и скорости после шага. Статика
/// (`inv_mass == 0 && inv_inertia == 0`) не меняется. Две точки манифольда
/// одной пары идут в `rows` подряд и решаются блоком 2×2. `rows` обязан
/// собираться с тем же `prediction`, что `soft_ccd_prediction` тела у хоста.
/// `cache` — память точек прошлого шага (`is_new`, warmstart): читается и
/// перезаписывается точками этого шага; точки, которых в `rows` нет,
/// забываются.
pub fn step_bodies(bodies: &mut [Body], rows: &[ContactRow], cache: &mut ContactCache, dt: f32) {
    let h = dt / SOLVER_SUBSTEPS as f32;
    let erp_inv_dt = contact_erp_inv_dt(h);
    let cfm = contact_cfm_factor(h);
    let mut constraints = std::mem::take(&mut cache.constraints);

    constraints.clear();
    build_constraints(bodies, rows, cache, &mut constraints);

    for _ in 0..SOLVER_SUBSTEPS {
        for constraint in constraints.iter_mut() {
            update_constraint(constraint, bodies, h, erp_inv_dt);
        }

        for constraint in &constraints {
            warmstart(constraint, bodies);
        }

        solve_constraints(&mut constraints, bodies, cfm);

        for body in bodies.iter_mut().filter(|body| !is_static(body)) {
            integrate_pose(body, h);
        }

        remove_bias(&mut constraints);
        solve_constraints(&mut constraints, bodies, 1.0);
    }

    for body in bodies.iter_mut().filter(|body| !is_static(body)) {
        let linear = 1.0 / (1.0 + dt * body.linear_damping);
        let angular = 1.0 / (1.0 + dt * body.angular_damping);

        body.vx *= linear;
        body.vy *= linear;
        body.angvel *= angular;
    }

    let mut next = std::mem::take(&mut cache.next);

    next.clear();
    next.extend(constraints.iter().map(|constraint| ContactMemory {
        key: constraint.key,
        warmstart_normal: constraint.normal.impulse,
        warmstart_tangent: constraint.tangential.impulse,
        total_normal: constraint.normal.accumulator + constraint.normal.impulse,
    }));
    next.sort_unstable_by_key(|memory| memory.key);

    cache.next = std::mem::replace(&mut cache.memory, next);
    cache.constraints = constraints;
}

#[cfg(test)]
mod tests {
    use super::*;

    const DT: f32 = 1.0 / 120.0;

    // разрешение одиночного контакта ровно в том порядке, в каком его делает
    // решатель игрового предиктора
    fn resolve_contact(a: &mut Body, b: &mut Body, contact: &Contact, surface: &Surface) {
        separate_bodies(a, b, contact, DT);
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

    // Две точки одного манифольда почти в одном месте: блок 2×2 почти
    // вырожден, но округление f32 оставляет определитель положительным, и
    // обращённая матрица блока в миллионы раз больше массы одной точки.
    // Решатель пары тогда накачивал энергию: тело отскакивало от стены
    // быстрее, чем влетало, и за несколько шагов у стены уходило в inf/NaN.
    // Прирост скорости обязан остаться тем же, что при разнесённых точках —
    // от выталкивания из проникновения (`MAX_CORRECTIVE_VELOCITY`)
    #[test]
    fn step_bodies_near_coincident_pair_does_not_pump_energy() {
        let mut seed = 12345_u32;
        let mut rnd = move || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed as f32 / u32::MAX as f32
        };
        let mut worst = 0.0_f32;

        for _ in 0..20_000 {
            let (ny, nx) = (rnd() * std::f32::consts::TAU).sin_cos();
            let (tx, ty) = (-ny, nx);
            let offset = (rnd() - 0.5) * 30.0;
            let gap = 10.0_f32.powf(-5.0 - rnd() * 2.0);
            let cx = 11.0 * nx + offset * tx;
            let cy = 11.0 * ny + offset * ty;
            let speed = rnd() * 300.0;
            let heading = rnd() * std::f32::consts::TAU;
            let mut bodies = [
                Body {
                    x: rnd(),
                    y: rnd(),
                    angle: rnd() * std::f32::consts::TAU,
                    vx: speed * heading.cos(),
                    vy: speed * heading.sin(),
                    angvel: (rnd() - 0.5) * 10.0,
                    inv_mass: 1.0 / 30.0,
                    inv_inertia: 1.0 / 4000.0,
                    linear_damping: 0.5,
                    angular_damping: 2.0,
                },
                static_body(),
            ];
            let depth0 = (rnd() - 0.3) * 2.0;
            let depth1 = depth0 + (rnd() - 0.5) * gap;
            let key = ContactKey::new(1, 2, 0);
            let row = |point: u8, shift: f32, depth: f32| ContactRow {
                a: 0,
                b: 1,
                contact: Contact {
                    nx,
                    ny,
                    depth,
                    cx: cx + shift * tx,
                    cy: cy + shift * ty,
                },
                surface: smooth(0.2),
                key: ContactKey { point, ..key },
            };
            let rows = [row(0, 0.0, depth0), row(1, gap, depth1)];
            let mut cache = ContactCache::new();

            for _ in 0..3 {
                step_bodies(&mut bodies, &rows, &mut cache, DT);
            }

            let b = bodies[0];

            for value in [b.x, b.y, b.angle, b.vx, b.vy, b.angvel] {
                assert!(value.is_finite(), "gap {gap}: {b:?}");
            }

            worst = worst.max(b.vx.hypot(b.vy) - speed);
        }

        // у разнесённых точек тот же прогон даёт ≈ 33
        assert!(worst < 40.0, "прирост скорости {worst}");
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

        // всё выталкивание шага досталось подвижному телу
        assert!((a.x + penetration_correction(2.0, DT)).abs() < 1e-5);
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
        let half = penetration_correction(2.0, DT) / 2.0;

        assert!((a.x + half).abs() < 1e-5);
        assert!((b.x - (8.0 + half)).abs() < 1e-5);
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
        let correction = penetration_correction(2.0, DT);

        assert!((light.x + correction * 0.8).abs() < 1e-5);
        assert!((heavy.x - (8.0 + correction * 0.2)).abs() < 1e-5);
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
        // равные массы: каждому телу достаётся половина коррекции шага
        let half = penetration_correction(2.0, DT) / 2.0;

        separate_bodies(&mut a, &mut b, &head_on(), DT);

        assert!((a.x + half).abs() < 1e-6);
        assert!((b.x - (8.0 + half)).abs() < 1e-6);
        assert_eq!(a.vx, 10.0);
        assert_eq!(b.vx, 0.0);
    }

    // регресс: развод на ВСЮ глубину за шаг. Хост (Rapier) растаскивает
    // глубокое перекрытие постепенно, реплика выталкивала за один шаг —
    // на упавшем в ящик танке предсказание рвало порог расхождения
    #[test]
    fn separate_bodies_corrects_a_fraction_of_a_deep_overlap() {
        let mut a = body();
        let mut b = Body {
            x: 8.0,
            ..static_body()
        };

        separate_bodies(&mut a, &mut b, &head_on(), DT);

        assert!(a.x < 0.0, "развод идёт");
        assert!(
            a.x.abs() < 2.0 * 0.2,
            "за шаг уходит малая часть глубины, а не вся"
        );
    }

    #[test]
    fn penetration_correction_is_capped_by_the_corrective_velocity() {
        // глубина, которую пружина сняла бы быстрее потолка
        let deep = MAX_CORRECTIVE_VELOCITY * DT / contact_erp(DT) * 2.0;

        assert!((penetration_correction(deep, DT) - MAX_CORRECTIVE_VELOCITY * DT).abs() < 1e-6);
    }

    #[test]
    fn penetration_correction_follows_the_spring_below_the_cap() {
        let shallow = 0.1;

        assert!(
            (penetration_correction(shallow, DT)
                - contact_erp(DT) * (shallow - ALLOWED_LINEAR_ERROR))
                .abs()
                < 1e-6
        );
    }

    #[test]
    fn penetration_correction_ignores_the_allowed_error() {
        assert_eq!(penetration_correction(ALLOWED_LINEAR_ERROR, DT), 0.0);
        assert_eq!(penetration_correction(1.0, 0.0), 0.0, "шага нет — коррекции нет");
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

        separate_bodies(&mut a, &mut b, &head_on(), DT);

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

        separate_bodies(&mut a, &mut b, &speculative(-0.5), DT);

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

    // — эталон хоста: тот же мир Rapier, что строит `game.rs` —

    // поза и скорости тела хоста (центр бокса)
    #[derive(Clone, Copy, Debug)]
    struct HostState {
        x: f32,
        y: f32,
        angle: f32,
        vx: f32,
        vy: f32,
        angvel: f32,
    }

    // танк 8×6 (m1: плотность 200, трение 0.5, упругость 0.1, демпфирование
    // 3 / 100, `soft_ccd_prediction` 6) со стартовой позой и скоростями
    // `start`; `wall_face` — грань неподвижной стены с дефолтами карты
    // (стена правее, лбом к ней — +x), `None` — стены нет. Мир — как у хоста:
    // без гравитации, `dt` 1/120, остальное по умолчанию. Возвращает
    // состояние после каждого шага
    fn rapier_run(start: HostState, wall_face: Option<f32>, steps: usize) -> Vec<HostState> {
        use rapier2d::prelude::*;

        let mut world = PhysicsWorld::new();

        world.gravity = Vector::ZERO;
        world.integration_parameters.dt = DT;

        let tank = world.insert_body(
            RigidBodyBuilder::dynamic()
                .translation(Vector::new(start.x, start.y))
                .rotation(start.angle)
                .linvel(Vector::new(start.vx, start.vy))
                .angvel(start.angvel)
                .linear_damping(3.0)
                .angular_damping(100.0)
                .soft_ccd_prediction(6.0),
        );

        world.insert_collider(
            ColliderBuilder::cuboid(4.0, 3.0)
                .density(200.0)
                .friction(0.5)
                .restitution(0.1),
            Some(tank),
        );

        if let Some(wall_face) = wall_face {
            let wall = world.insert_body(
                RigidBodyBuilder::fixed().translation(Vector::new(wall_face + 6.4, 0.0)),
            );

            world.insert_collider(
                ColliderBuilder::cuboid(6.4, 51.2)
                    .friction(DEFAULT_FRICTION)
                    .restitution(DEFAULT_RESTITUTION),
                Some(wall),
            );
        }

        (0..steps)
            .map(|_| {
                world.step();

                let body = &world.bodies[tank];

                HostState {
                    x: body.translation().x,
                    y: body.translation().y,
                    angle: body.rotation().angle(),
                    vx: body.linvel().x,
                    vy: body.linvel().y,
                    angvel: body.angvel(),
                }
            })
            .collect()
    }

    // старт из начала координат лбом (+x) со скоростью `speed`
    fn head_on_start(speed: f32) -> HostState {
        HostState {
            x: 0.0,
            y: 0.0,
            angle: 0.0,
            vx: speed,
            vy: 0.0,
            angvel: 0.0,
        }
    }

    fn rapier_head_on(speed: f32, wall_face: f32, steps: usize) -> Vec<HostState> {
        rapier_run(head_on_start(speed), Some(wall_face), steps)
    }

    // — реплика того же мира: `step_bodies` с контактами `obb_manifold` —

    fn replica_tank(start: HostState) -> Body {
        let props = box_mass_properties(8.0, 6.0, 200.0);

        Body {
            x: start.x,
            y: start.y,
            angle: start.angle,
            vx: start.vx,
            vy: start.vy,
            angvel: start.angvel,
            inv_mass: props.inv_mass,
            inv_inertia: props.inv_inertia,
            linear_damping: 3.0,
            angular_damping: 100.0,
        }
    }

    fn tank_surface() -> Surface {
        combine_surfaces(
            &Surface {
                friction: 0.5,
                restitution: 0.1,
            },
            &MAP_SURFACE,
        )
    }

    // контакты танка (тело 0) со стеной (тело 1) на текущей позе — как их
    // собирает игровой предиктор: манифольд с предсказанием 6
    fn wall_rows(bodies: &[Body]) -> Vec<ContactRow> {
        use crate::client::collision::obb_manifold;
        use crate::client::raycast::Box2;

        let tank = Box2 {
            x: bodies[0].x,
            y: bodies[0].y,
            angle: bodies[0].angle,
            half_w: 4.0,
            half_h: 3.0,
        };
        let wall = Box2 {
            x: bodies[1].x,
            y: bodies[1].y,
            angle: 0.0,
            half_w: 6.4,
            half_h: 51.2,
        };

        obb_manifold(&tank, &wall, 6.0).map_or_else(Vec::new, |manifold| {
            ContactRow::from_manifold(0, 1, &manifold, tank_surface(), ContactKey::new(0, 1, 0)).collect()
        })
    }

    fn to_host(body: &Body) -> HostState {
        HostState {
            x: body.x,
            y: body.y,
            angle: body.angle,
            vx: body.vx,
            vy: body.vy,
            angvel: body.angvel,
        }
    }

    // реплика `rapier_run`: тот же старт, `step_bodies` на каждом шаге
    fn replica_run(
        start: HostState,
        wall_face: Option<f32>,
        steps: usize,
        cache: &mut ContactCache,
    ) -> Vec<HostState> {
        let wall = Body {
            x: wall_face.unwrap_or(1.0e6) + 6.4,
            ..static_body()
        };
        let mut bodies = [replica_tank(start), wall];

        (0..steps)
            .map(|_| {
                let rows = if wall_face.is_some() {
                    wall_rows(&bodies)
                } else {
                    Vec::new()
                };

                step_bodies(&mut bodies, &rows, cache, DT);

                to_host(&bodies[0])
            })
            .collect()
    }

    // зазоры таблицы эталона (`rapier_head_on_regimes`), путь за шаг 1.167
    const GAP_REGIMES: [f32; 7] = [0.05, 0.40, 0.80, 0.85, 0.90, 1.00, 1.15];

    #[test]
    fn rapier_head_on_regimes() {
        // свидетель хоста: итог удара зависит от того, на каком из четырёх
        // подшагов TGS закрывается зазор. Раньше последнего — отскок −e·v
        // (e = 0.05, затем демпфирование); на последнем — отскока нет,
        // остаётся скорость закрытия остатка зазора, а на следующем шаге
        // точка уже не новая и гасится в ноль. Реплика обязана повторить
        // обе ветки, а не одно правило «закрылся — отскочил».
        // (зазор, vx после шага удара, vx после следующего); путь за шаг 1.167
        let regimes: [(f32, f32, f32); 7] = [
            (0.05, -6.839, -6.672),
            (0.40, -6.837, -6.671),
            (0.80, -6.829, -6.663),
            (0.85, -3.648, -3.559),
            (0.90, 4.878, 0.0),
            (1.00, 51.707, -0.022),
            (1.15, 121.951, 0.0),
        ];

        for (gap, hit_vx, next_vx) in regimes {
            let wall_face = 4.0 + gap;
            let trace = rapier_head_on(140.0, wall_face, 2);

            for (step, (state, expected)) in trace.iter().zip([hit_vx, next_vx]).enumerate() {
                let penetration = state.x + 4.0 - wall_face;

                assert!(
                    (state.vx - expected).abs() < 0.1,
                    "зазор {gap}, шаг {step}: vx {} вместо {expected}",
                    state.vx
                );
                assert!(penetration < 0.05, "зазор {gap}, шаг {step}: проникновение {penetration}");
                assert!(state.y.abs() < 1e-3 && state.vy.abs() < 1e-2, "зазор {gap}: снос {state:?}");
                assert!(state.angle.abs() < 1e-3 && state.angvel.abs() < 1e-2, "зазор {gap}: разворот {state:?}");
            }
        }
    }

    // — `step_bodies`: шаг как у Rapier —

    #[test]
    fn step_bodies_matches_rapier_across_gap_regimes() {
        // критерий приёмки: на всех режимах зазора — и когда он закрывается
        // раньше последнего подшага (отскок), и когда на последнем (отскока
        // нет, следующий шаг гасит скорость) — реплика повторяет хост
        for gap in GAP_REGIMES {
            let wall_face = 4.0 + gap;
            let host = rapier_head_on(140.0, wall_face, 2);
            let replica = replica_run(head_on_start(140.0), Some(wall_face), 2, &mut ContactCache::new());

            for (step, (h, r)) in host.iter().zip(&replica).enumerate() {
                let host_depth = h.x + 4.0 - wall_face;
                let replica_depth = r.x + 4.0 - wall_face;

                assert!(
                    (h.vx - r.vx).abs() < 0.1,
                    "зазор {gap}, шаг {step}: vx хоста {}, реплики {}",
                    h.vx,
                    r.vx
                );
                assert!(
                    (host_depth - replica_depth).abs() < 0.01,
                    "зазор {gap}, шаг {step}: проникновение хоста {host_depth}, реплики {replica_depth}"
                );
                // `vy` и `ω` — с хостом, а не с нулём: у почти симметричной
                // пары точек ветку блочного решателя («толкают обе» или
                // «толкает одна») выбирает округление f32, и хост сам
                // получает снос порядка 3e-3; бит в бит этот выбор не
                // повторить
                assert!(
                    (h.vy - r.vy).abs() < 1e-2 && (h.angvel - r.angvel).abs() < 1e-2,
                    "зазор {gap}, шаг {step}: хост {h:?}, реплика {r:?}"
                );
            }
        }
    }

    #[test]
    fn a_contact_that_pushed_last_step_does_not_bounce() {
        // зазор закрылся на последнем подшаге: точка получила импульс и на
        // следующем шаге уже не новая — отскока нет, скорость гасится в ноль
        let replica = replica_run(head_on_start(140.0), Some(4.9), 2, &mut ContactCache::new());

        assert!(replica[0].vx > 0.0, "на шаге удара отскока нет: {:?}", replica[0]);
        // отскок был бы ≈ −6.8; остаток — округление ветки блочного решателя
        assert!(replica[1].vx.abs() < 0.1, "{:?}", replica[1]);
    }

    #[test]
    fn a_gap_not_closed_this_step_is_untouched() {
        // зазор 3 при пути за шаг 1.167 — контакт есть, но импульса нет
        let mut bodies = [replica_tank(head_on_start(140.0)), Body { x: 7.0 + 6.4, ..static_body() }];
        let rows = wall_rows(&bodies);
        let mut free = bodies[0];

        assert!(!rows.is_empty(), "контакт в пределах предсказания");

        step_bodies(&mut bodies, &rows, &mut ContactCache::new(), DT);
        integrate(&mut free, DT);

        assert!((bodies[0].x - free.x).abs() < 1e-4, "{:?} / {free:?}", bodies[0]);
        assert!((bodies[0].vx - free.vx).abs() < 1e-4);
        assert_eq!(bodies[0].vy, 0.0);
        assert_eq!(bodies[0].angvel, 0.0);
    }

    #[test]
    fn two_point_manifold_does_not_slide_sideways() {
        // лобовой удар гранью: две точки манифольда. Поточечный решатель
        // разворачивает корпус первой точкой и сносит его вбок, блочный
        // решатель пары (как у Rapier в 2D) — нет
        let wall_face = 4.0 + 0.4;
        let mut bodies = [replica_tank(head_on_start(140.0)), Body { x: wall_face + 6.4, ..static_body() }];
        let rows = wall_rows(&bodies);

        assert_eq!(rows.len(), 2);

        let mut sequential = bodies;
        let mut acc = [ContactImpulses::default(); 2];

        for _ in 0..4 {
            for (row, state) in rows.iter().zip(acc.iter_mut()) {
                let [tank, wall] = &mut sequential;

                apply_contact_impulse(tank, wall, &row.contact, &row.surface, DT, state);
            }
        }

        step_bodies(&mut bodies, &rows, &mut ContactCache::new(), DT);

        let old = sequential[0].vy.abs() + sequential[0].angvel.abs();
        let new = bodies[0].vy.abs() + bodies[0].angvel.abs();

        assert!(old > 1e-3, "поточечный решатель сносит корпус: {:?}", sequential[0]);
        assert!(new * 10.0 < old, "снос {new} против {old}");
    }

    #[test]
    fn resting_contact_stays_at_rest() {
        // корпус стоит вплотную к стене: warmstart и мягкость не дают ему ни
        // дрожать, ни уползать
        let start = head_on_start(0.0);
        let replica = replica_run(start, Some(4.0), 60, &mut ContactCache::new());

        for state in &replica {
            assert!(state.x.abs() < 1e-3, "{state:?}");
            assert!(state.vx.abs() < 1e-3 && state.vy.abs() < 1e-3, "{state:?}");
            assert!(state.angvel.abs() < 1e-3, "{state:?}");
        }
    }

    #[test]
    fn penetration_is_removed_like_rapier() {
        // старт с перекрытием 0.5: мягкая пружина на подшагах разводит тела
        // так же, как у хоста
        let wall_face = 3.5;
        let host = rapier_run(head_on_start(0.0), Some(wall_face), 20);
        let replica = replica_run(head_on_start(0.0), Some(wall_face), 20, &mut ContactCache::new());

        for step in [0, 4, 19] {
            let host_depth = host[step].x + 4.0 - wall_face;
            let replica_depth = replica[step].x + 4.0 - wall_face;

            assert!(
                (host_depth - replica_depth).abs() < 0.01,
                "шаг {}: хост {host_depth}, реплика {replica_depth}",
                step + 1
            );
        }
    }

    #[test]
    fn no_contacts_matches_rapier() {
        // без контактов шаг — те же подшаги с линеаризованным поворотом
        let start = HostState {
            x: 1.0,
            y: -2.0,
            angle: 0.4,
            vx: 30.0,
            vy: -20.0,
            angvel: 8.0,
        };
        let host = rapier_run(start, None, 10);
        let replica = replica_run(start, None, 10, &mut ContactCache::new());

        for (h, r) in host.iter().zip(&replica) {
            assert!((h.x - r.x).abs() < 1e-4 && (h.y - r.y).abs() < 1e-4, "{h:?} / {r:?}");
            assert!((h.angle - r.angle).abs() < 1e-5, "{h:?} / {r:?}");
            assert!((h.vx - r.vx).abs() < 1e-4 && (h.vy - r.vy).abs() < 1e-4, "{h:?} / {r:?}");
            assert!((h.angvel - r.angvel).abs() < 1e-5, "{h:?} / {r:?}");
        }
    }

    #[test]
    fn rotated_hull_at_the_wall_matches_rapier() {
        // риск ключей: корпус входит в стену под углом и проворачивается у
        // неё — точки манифольда меняют плечи, warmstart обязан попадать в
        // свою точку
        let start = HostState {
            angle: 0.3,
            ..head_on_start(140.0)
        };
        let host = rapier_run(start, Some(5.0), 30);
        let replica = replica_run(start, Some(5.0), 30, &mut ContactCache::new());

        for (step, (h, r)) in host.iter().zip(&replica).enumerate() {
            assert!(
                (h.vx - r.vx).abs() < 0.1 && (h.vy - r.vy).abs() < 0.1 && (h.angvel - r.angvel).abs() < 0.1,
                "шаг {step}: хост {h:?}, реплика {r:?}"
            );
        }
    }

    #[test]
    fn contact_cache_clone_restores_the_memory() {
        // контракт отката предиктора: снимок кэша, шаг, откат к снимку, тот
        // же шаг — тот же итог бит в бит
        let wall_face = 4.9;
        let mut cache = ContactCache::new();
        let mut bodies = [replica_tank(head_on_start(140.0)), Body { x: wall_face + 6.4, ..static_body() }];

        let rows = wall_rows(&bodies);

        step_bodies(&mut bodies, &rows, &mut cache, DT);

        let snapshot = (bodies, cache.clone());
        let rows = wall_rows(&bodies);

        step_bodies(&mut bodies, &rows, &mut cache, DT);

        let (mut replay, mut restored) = snapshot;

        step_bodies(&mut replay, &rows, &mut restored, DT);

        assert_eq!(replay, bodies);
    }

    #[test]
    fn a_forgotten_contact_is_new_again() {
        // точка, пропавшая из `rows`, уходит из кэша: вернувшись, она снова
        // новая — так же, как после `clear`
        let wall_face = 4.9;
        let start = [replica_tank(head_on_start(140.0)), Body { x: wall_face + 6.4, ..static_body() }];

        let run = |forget: &dyn Fn(&mut ContactCache, [Body; 2])| {
            let mut bodies = start;
            let mut cache = ContactCache::new();
            let rows = wall_rows(&bodies);

            step_bodies(&mut bodies, &rows, &mut cache, DT);
            forget(&mut cache, bodies);

            let rows = wall_rows(&bodies);

            step_bodies(&mut bodies, &rows, &mut cache, DT);

            bodies[0]
        };

        let remembered = run(&|_, _| {});
        let cleared = run(&|cache, _| cache.clear());
        let skipped = run(&|cache, mut bodies| step_bodies(&mut bodies, &[], cache, DT));

        assert_eq!(cleared, skipped);
        assert_ne!(cleared, remembered, "новая точка отскакивает, старая — нет");
    }

    #[test]
    fn step_bodies_never_moves_static_bodies() {
        let wall = Body { x: 4.4 + 6.4, ..static_body() };
        let mut bodies = [replica_tank(head_on_start(140.0)), wall];
        let mut cache = ContactCache::new();

        for _ in 0..10 {
            let rows = wall_rows(&bodies);

            step_bodies(&mut bodies, &rows, &mut cache, DT);
        }

        assert_eq!(bodies[1], wall);
    }

    #[test]
    fn rows_from_a_manifold_are_its_solver_points_in_a_row() {
        use crate::client::collision::obb_manifold;
        use crate::client::raycast::Box2;

        let box2 = |x: f32| Box2 {
            x,
            y: 0.0,
            angle: 0.0,
            half_w: 5.0,
            half_h: 5.0,
        };
        let manifold = obb_manifold(&box2(0.0), &box2(11.0), 2.0).expect("манифольд");
        let rows: Vec<ContactRow> =
            ContactRow::from_manifold(3, 7, &manifold, MAP_SURFACE, ContactKey::new(40, 50, 0)).collect();
        let points: Vec<Contact> = manifold.solver_points().collect();

        assert_eq!(rows.len(), 2);

        for (point, (row, solver)) in rows.iter().zip(&points).enumerate() {
            assert_eq!((row.a, row.b), (3, 7));
            assert_eq!(row.key, ContactKey::new(40, 50, point as u8));
            assert_eq!(row.surface, MAP_SURFACE);
            assert_eq!((row.contact.cx, row.contact.cy), (solver.cx, solver.cy));
        }
    }

    #[test]
    fn a_point_keeps_its_key_when_its_neighbour_drops_out() {
        // корпус под углом: у падающей грани уцелела только вторая вершина,
        // первая ушла за предсказание. Ключ — номер вершины грани, а не
        // место среди уцелевших: иначе точка унаследовала бы память соседки
        // (warmstart и «не новая» — без отскока), а у parry у неё своя
        use crate::client::collision::obb_manifold;
        use crate::client::raycast::Box2;

        let tank = Box2 {
            x: 0.0,
            y: 0.0,
            angle: -0.4,
            half_w: 4.0,
            half_h: 3.0,
        };
        let wall = Box2 {
            x: 4.5 + 6.4,
            y: 0.0,
            angle: 0.0,
            half_w: 6.4,
            half_h: 51.2,
        };
        let manifold = obb_manifold(&tank, &wall, 1.0).expect("манифольд");
        let rows: Vec<ContactRow> =
            ContactRow::from_manifold(0, 1, &manifold, MAP_SURFACE, ContactKey::new(0, 1, 0)).collect();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].key, ContactKey::new(0, 1, 1));
    }

    #[test]
    fn a_pair_block_joins_only_the_two_points_of_one_manifold() {
        // все стены — одно статическое тело среза (индекс 1): одноточечный
        // манифольд правой стены, затем двухточечный нижней. Блок 2×2 —
        // только внутри манифольда; склейка по индексам тел решала бы
        // точку одной стены вдоль нормали другой. Итог обязан совпасть с
        // тем же шагом, где у каждой стены своё тело
        let point = |nx: f32, ny: f32, cx: f32, cy: f32| Contact {
            nx,
            ny,
            depth: -0.1,
            cx,
            cy,
        };
        let row = |b: usize, contact: Contact, name: u32, point: u8| ContactRow {
            a: 0,
            b,
            contact,
            surface: tank_surface(),
            key: ContactKey::new(0, name, point),
        };
        let run = |right: usize, floor: usize| {
            let mut bodies = [
                Body {
                    vx: 150.0,
                    vy: 150.0,
                    ..replica_tank(head_on_start(0.0))
                },
                static_body(),
                static_body(),
            ];
            let rows = [
                row(right, point(1.0, 0.0, 4.0, 1.0), 10, 0),
                row(floor, point(0.0, 1.0, -4.0, 3.0), 11, 0),
                row(floor, point(0.0, 1.0, 4.0, 3.0), 11, 1),
            ];

            step_bodies(&mut bodies, &rows, &mut ContactCache::new(), DT);

            bodies[0]
        };

        assert_eq!(run(1, 1), run(1, 2));
    }
}
