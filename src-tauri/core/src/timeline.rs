//! Mapping from the original timeline to the edited one.

use serde::{Deserialize, Serialize};

/// A piece of the output timeline, in output order.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Piece {
    /// A stretch of the source that is kept: [src_start, src_end) lasting `dur` seconds in the output
    Kept { src_start: f64, src_end: f64, dur: f64 },
    /// An inserted card lasting `dur` seconds
    Card { dur: f64 },
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineMap {
    pub pieces: Vec<Piece>,
    /// output start time of every piece
    pub offsets: Vec<f64>,
}

impl TimelineMap {
    pub fn new(pieces: Vec<Piece>) -> Self {
        let mut offsets = Vec::with_capacity(pieces.len());
        let mut t = 0.0;
        for p in &pieces {
            offsets.push(t);
            t += match p {
                Piece::Kept { dur, .. } => *dur,
                Piece::Card { dur } => *dur,
            };
        }
        TimelineMap { pieces, offsets }
    }

    pub fn identity(duration: f64) -> Self {
        TimelineMap::new(vec![Piece::Kept { src_start: 0.0, src_end: duration, dur: duration }])
    }

    pub fn total(&self) -> f64 {
        self.offsets
            .last()
            .map(|o| {
                o + match self.pieces.last() {
                    Some(Piece::Kept { dur, .. }) | Some(Piece::Card { dur }) => *dur,
                    None => 0.0,
                }
            })
            .unwrap_or(0.0)
    }

    /// Map an instant. Returns None when it falls inside a removed range.
    pub fn map_time(&self, t: f64) -> Option<f64> {
        for (p, off) in self.pieces.iter().zip(&self.offsets) {
            if let Piece::Kept { src_start, src_end, .. } = p {
                if t >= *src_start && t < *src_end {
                    return Some(t - src_start + off);
                }
            }
        }
        None
    }

    /// Map a range [a, b). The end is clamped to the end of the kept piece the start falls in.
    /// Returns None when the start is inside a removed range or the result would be empty.
    pub fn map_range(&self, a: f64, b: f64) -> Option<(f64, f64)> {
        for (p, off) in self.pieces.iter().zip(&self.offsets) {
            if let Piece::Kept { src_start, src_end, .. } = p {
                if a >= *src_start && a < *src_end {
                    let na = a - src_start + off;
                    let nb = b.min(*src_end) - src_start + off;
                    if nb <= na {
                        return None;
                    }
                    return Some((na, nb));
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_across_a_cut_and_card() {
        let m = TimelineMap::new(vec![
            Piece::Kept { src_start: 0.0, src_end: 10.0, dur: 10.0 },
            Piece::Card { dur: 5.0 },
            Piece::Kept { src_start: 20.0, src_end: 30.0, dur: 10.0 },
        ]);
        assert_eq!(m.map_time(5.0), Some(5.0));
        assert_eq!(m.map_time(15.0), None);
        assert_eq!(m.map_time(25.0), Some(20.0));
        assert_eq!(m.map_range(8.0, 12.0), Some((8.0, 10.0)));
        assert_eq!(m.total(), 25.0);
    }
}
