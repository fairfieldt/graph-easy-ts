// Ported constants from Graph::Easy::Edge::Cell (Graph-Easy 0.76).
//
// These numeric values matter because Perl uses bit-masks for edge types and flags.

// Basic edge cell types.
export const EDGE_CROSS = 0; // +
export const EDGE_HOR = 1; // --
export const EDGE_VER = 2; // |

export const EDGE_N_E = 3;
export const EDGE_N_W = 4;
export const EDGE_S_E = 5;
export const EDGE_S_W = 6;

// Joints.
export const EDGE_S_E_W = 7;
export const EDGE_N_E_W = 8;
export const EDGE_E_N_S = 9;
export const EDGE_W_N_S = 10;

export const EDGE_HOLE = 11;

// Loop types.
export const EDGE_N_W_S = 12;
export const EDGE_S_W_N = 13;
export const EDGE_E_S_W = 14;
export const EDGE_W_S_E = 15;

export const EDGE_MAX_TYPE = 15;
export const EDGE_LOOP_TYPE = 12;

// Flags.
export const EDGE_START_E = 0x0100;
export const EDGE_START_S = 0x0200;
export const EDGE_START_W = 0x0400;
export const EDGE_START_N = 0x0800;

export const EDGE_END_W = 0x0010;
export const EDGE_END_N = 0x0020;
export const EDGE_END_E = 0x0040;
export const EDGE_END_S = 0x0080;

export const EDGE_LABEL_CELL = 0x1000;
export const EDGE_SHORT_CELL = 0x2000;

export const EDGE_ARROW_MASK = 0x0ff0;
export const EDGE_START_MASK = 0x0f00;
export const EDGE_END_MASK = 0x00f0;

export const EDGE_TYPE_MASK = 0x000f;
export const EDGE_FLAG_MASK = 0xfff0;
export const EDGE_MISC_MASK = 0xf000;
export const EDGE_NO_M_MASK = 0x0fff;

export const ARROW_RIGHT = 0;
export const ARROW_LEFT = 1;
export const ARROW_UP = 2;
export const ARROW_DOWN = 3;

// Shortcuts.
export const EDGE_ARROW_HOR = EDGE_END_E + EDGE_END_W;
export const EDGE_ARROW_VER = EDGE_END_N + EDGE_END_S;

export const EDGE_SHORT_E = EDGE_HOR + EDGE_END_E + EDGE_START_W;
export const EDGE_SHORT_S = EDGE_VER + EDGE_END_S + EDGE_START_N;
export const EDGE_SHORT_W = EDGE_HOR + EDGE_END_W + EDGE_START_E;
export const EDGE_SHORT_N = EDGE_VER + EDGE_END_N + EDGE_START_S;

export const EDGE_SHORT_BD_EW = EDGE_HOR + EDGE_END_E + EDGE_END_W;
export const EDGE_SHORT_BD_NS = EDGE_VER + EDGE_END_S + EDGE_END_N;

export const EDGE_SHORT_UN_EW = EDGE_HOR + EDGE_START_E + EDGE_START_W;
export const EDGE_SHORT_UN_NS = EDGE_VER + EDGE_START_S + EDGE_START_N;

export const EDGE_LOOP_NORTH = EDGE_N_W_S + EDGE_END_S + EDGE_START_N + EDGE_LABEL_CELL;
export const EDGE_LOOP_SOUTH = EDGE_S_W_N + EDGE_END_N + EDGE_START_S + EDGE_LABEL_CELL;
export const EDGE_LOOP_WEST = EDGE_W_S_E + EDGE_END_E + EDGE_START_W + EDGE_LABEL_CELL;
export const EDGE_LOOP_EAST = EDGE_E_S_W + EDGE_END_W + EDGE_START_E + EDGE_LABEL_CELL;
