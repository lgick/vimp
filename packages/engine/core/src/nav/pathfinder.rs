use std::cmp::Ordering;
use std::collections::BinaryHeap;

/// Ребро навигационного графа.
#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct Edge {
    pub node: usize,
    pub weight: f32,
}

fn heuristic(a: [f32; 2], b: [f32; 2]) -> f32 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];

    (dx * dx + dy * dy).sqrt()
}

/// Запись открытого множества A*. Порядок кучи: меньший `f` — выше, при
/// равенстве — меньший `node` (детерминированный разрыв ничьих).
struct Open {
    f: f32,
    node: usize,
}

impl PartialEq for Open {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Open {}

impl PartialOrd for Open {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Open {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .f
            .total_cmp(&self.f)
            .then_with(|| other.node.cmp(&self.node))
    }
}

/// A* по графу (порт src/server/modules/bots/Pathfinder.js).
/// Возвращает индексы узлов пути или None.
pub fn find_path(
    start_node: usize,
    end_node: usize,
    nodes: &[[f32; 2]],
    edges: &[Vec<Edge>],
) -> Option<Vec<usize>> {
    find_path_with(start_node, end_node, nodes, edges, |_, _, edge| {
        Some(edge.weight)
    })
    .map(|(path, _)| path)
}

/// A* с настраиваемой стоимостью ребра: `cost(from, edge_index, edge)` —
/// `Some(стоимость ≥ 0)` или `None` (ребро запрещено). Эвристика — евклидова
/// дистанция, поэтому стоимость ребра обязана быть не меньше его длины,
/// иначе путь перестаёт быть кратчайшим.
/// Возвращает индексы узлов пути и его полную стоимость.
pub fn find_path_with<F>(
    start_node: usize,
    end_node: usize,
    nodes: &[[f32; 2]],
    edges: &[Vec<Edge>],
    mut cost: F,
) -> Option<(Vec<usize>, f32)>
where
    F: FnMut(usize, usize, &Edge) -> Option<f32>,
{
    if start_node >= nodes.len() || end_node >= nodes.len() {
        return None;
    }

    if start_node == end_node {
        return Some((vec![start_node], 0.0));
    }

    let mut g_score = vec![f32::INFINITY; nodes.len()];
    let mut came_from = vec![usize::MAX; nodes.len()];
    let mut closed = vec![false; nodes.len()];
    let mut open_set = BinaryHeap::new();

    g_score[start_node] = 0.0;
    open_set.push(Open {
        f: heuristic(nodes[start_node], nodes[end_node]),
        node: start_node,
    });

    while let Some(Open { node: current, .. }) = open_set.pop() {
        // ленивое удаление: устаревшие записи кучи пропускаются
        if closed[current] {
            continue;
        }

        if current == end_node {
            return Some((reconstruct_path(&came_from, current), g_score[current]));
        }

        closed[current] = true;

        let Some(current_edges) = edges.get(current) else {
            continue;
        };

        for (index, edge) in current_edges.iter().enumerate() {
            if closed[edge.node] {
                continue;
            }

            let Some(edge_cost) = cost(current, index, edge) else {
                continue;
            };

            debug_assert!(edge_cost >= 0.0, "отрицательная стоимость ребра");

            let tentative = g_score[current] + edge_cost;

            if tentative < g_score[edge.node] {
                came_from[edge.node] = current;
                g_score[edge.node] = tentative;
                open_set.push(Open {
                    f: tentative + heuristic(nodes[edge.node], nodes[end_node]),
                    node: edge.node,
                });
            }
        }
    }

    None
}

fn reconstruct_path(came_from: &[usize], mut current: usize) -> Vec<usize> {
    let mut total_path = vec![current];

    while came_from[current] != usize::MAX {
        current = came_from[current];
        total_path.push(current);
    }

    total_path.reverse();

    total_path
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::rng::Rng;

    #[test]
    fn finds_shortest_path_in_simple_graph() {
        // 0 -- 1 -- 2, и обход 0 -- 3 -- 2 длиннее
        let nodes = [[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [1.0, 5.0]];
        let edges = vec![
            vec![Edge { node: 1, weight: 1.0 }, Edge { node: 3, weight: 5.0 }],
            vec![Edge { node: 0, weight: 1.0 }, Edge { node: 2, weight: 1.0 }],
            vec![Edge { node: 1, weight: 1.0 }, Edge { node: 3, weight: 5.0 }],
            vec![Edge { node: 0, weight: 5.0 }, Edge { node: 2, weight: 5.0 }],
        ];

        let path = find_path(0, 2, &nodes, &edges).unwrap();

        assert_eq!(path, vec![0, 1, 2]);
    }

    #[test]
    fn returns_none_when_unreachable() {
        let nodes = [[0.0, 0.0], [1.0, 0.0]];
        let edges = vec![vec![], vec![]];

        assert!(find_path(0, 1, &nodes, &edges).is_none());
    }

    // решётка size×size с шагом 1 и рёбрами по четырём сторонам
    fn lattice(size: usize) -> (Vec<[f32; 2]>, Vec<Vec<Edge>>) {
        let mut nodes = Vec::new();
        let mut edges = vec![Vec::new(); size * size];

        for y in 0..size {
            for x in 0..size {
                nodes.push([x as f32, y as f32]);
            }
        }

        for y in 0..size {
            for x in 0..size {
                let index = y * size + x;

                if x + 1 < size {
                    edges[index].push(Edge {
                        node: index + 1,
                        weight: 1.0,
                    });
                    edges[index + 1].push(Edge {
                        node: index,
                        weight: 1.0,
                    });
                }

                if y + 1 < size {
                    edges[index].push(Edge {
                        node: index + size,
                        weight: 1.0,
                    });
                    edges[index + size].push(Edge {
                        node: index,
                        weight: 1.0,
                    });
                }
            }
        }

        (nodes, edges)
    }

    #[test]
    fn astar_ties_are_deterministic() {
        let (nodes, edges) = lattice(4);
        let first = find_path(0, 15, &nodes, &edges).unwrap();
        let second = find_path(0, 15, &nodes, &edges).unwrap();

        assert_eq!(first, second);
        // кратчайший путь из угла в угол — 6 шагов, 7 узлов
        assert_eq!(first.len(), 7);
    }

    // эталон: Дейкстра за O(n²)
    fn dijkstra(start: usize, end: usize, edges: &[Vec<Edge>]) -> Option<f32> {
        let mut dist = vec![f32::INFINITY; edges.len()];
        let mut done = vec![false; edges.len()];

        dist[start] = 0.0;

        loop {
            let current = (0..edges.len())
                .filter(|&i| !done[i] && dist[i].is_finite())
                .min_by(|&a, &b| dist[a].total_cmp(&dist[b]))?;

            if current == end {
                return Some(dist[end]);
            }

            done[current] = true;

            for edge in &edges[current] {
                dist[edge.node] = dist[edge.node].min(dist[current] + edge.weight);
            }
        }
    }

    #[test]
    fn astar_matches_dijkstra_on_random_graphs() {
        let mut rng = Rng::new(7);

        for _ in 0..20 {
            let nodes: Vec<[f32; 2]> = (0..30)
                .map(|_| [rng.range(0.0, 100.0), rng.range(0.0, 100.0)])
                .collect();
            let mut edges = vec![Vec::new(); nodes.len()];

            for (from, list) in edges.iter_mut().enumerate() {
                for to in 0..nodes.len() {
                    if to != from && rng.next_f32() < 0.15 {
                        // вес не меньше евклидовой длины: эвристика допустима
                        let weight = heuristic(nodes[from], nodes[to]) * rng.range(1.0, 2.0);

                        list.push(Edge { node: to, weight });
                    }
                }
            }

            let expected = dijkstra(0, 29, &edges);
            let actual = find_path_with(0, 29, &nodes, &edges, |_, _, edge| Some(edge.weight))
                .map(|(_, cost)| cost);

            match (expected, actual) {
                (None, None) => {}
                (Some(e), Some(a)) => assert!((e - a).abs() < 1e-3, "{e} != {a}"),
                other => panic!("{other:?}"),
            }
        }
    }

    #[test]
    fn forbidden_edge_is_skipped() {
        let (nodes, edges) = lattice(3);

        // прямое ребро 0 → 1 запрещено: путь в обход через нижний ряд
        let (path, cost) = find_path_with(0, 1, &nodes, &edges, |from, _, edge| {
            (from != 0 || edge.node != 1).then_some(edge.weight)
        })
        .unwrap();

        assert_eq!(path, vec![0, 3, 4, 1]);
        assert_eq!(cost, 3.0);
    }
}
