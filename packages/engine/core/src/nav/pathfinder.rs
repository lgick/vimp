use std::collections::HashMap;

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

/// A* по графу (порт src/server/modules/bots/Pathfinder.js).
/// Возвращает индексы узлов пути или None.
pub fn find_path(
    start_node: usize,
    end_node: usize,
    nodes: &[[f32; 2]],
    edges: &[Vec<Edge>],
) -> Option<Vec<usize>> {
    let mut open_set = vec![start_node];
    let mut came_from: HashMap<usize, usize> = HashMap::new();

    let mut g_score: HashMap<usize, f32> = HashMap::new();
    let mut f_score: HashMap<usize, f32> = HashMap::new();

    g_score.insert(start_node, 0.0);
    f_score.insert(start_node, heuristic(nodes[start_node], nodes[end_node]));

    while !open_set.is_empty() {
        // узел с наименьшим fScore
        let mut current = open_set[0];

        for &candidate in open_set.iter().skip(1) {
            if f_score.get(&candidate).copied().unwrap_or(f32::INFINITY)
                < f_score.get(&current).copied().unwrap_or(f32::INFINITY)
            {
                current = candidate;
            }
        }

        if current == end_node {
            return Some(reconstruct_path(&came_from, current));
        }

        let index = open_set.iter().position(|&n| n == current).unwrap();

        open_set.remove(index);

        for edge in &edges[current] {
            let tentative = g_score[&current] + edge.weight;
            // отсутствующий gScore — бесконечность (см. комментарий в JS-версии
            // о ловушке `|| Infinity` для нулевого значения)
            let neighbor_score = g_score.get(&edge.node).copied().unwrap_or(f32::INFINITY);

            if tentative < neighbor_score {
                came_from.insert(edge.node, current);
                g_score.insert(edge.node, tentative);
                f_score.insert(
                    edge.node,
                    tentative + heuristic(nodes[edge.node], nodes[end_node]),
                );

                if !open_set.contains(&edge.node) {
                    open_set.push(edge.node);
                }
            }
        }
    }

    None
}

fn reconstruct_path(came_from: &HashMap<usize, usize>, mut current: usize) -> Vec<usize> {
    let mut total_path = vec![current];

    while let Some(&previous) = came_from.get(&current) {
        current = previous;
        total_path.insert(0, current);
    }

    total_path
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
