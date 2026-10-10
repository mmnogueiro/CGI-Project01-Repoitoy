#version 300 es

// The corners of the quad are already in clip space, so they pass straight
// through.

in vec2 a_position;

void main() {
    gl_Position = vec4(a_position, 0.0f, 1.0f);
}
