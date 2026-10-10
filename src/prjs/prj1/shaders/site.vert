#version 300 es

// Site marker: converts a site position from world coordinates to clip
// space. This is the exact inverse of screen_to_world() in app.js.

in vec2 a_position;         // site position, in world coordinates

uniform vec2  u_pan;        // world offset (pan), in world units
uniform float u_zoom;       // scale factor (> 1 = zoomed in)
uniform float u_aspect;     // canvas width / height

void main() {
    float clip_x = (a_position.x + u_pan.x) * u_zoom / u_aspect;   // aspect corrects x only
    float clip_y = (a_position.y + u_pan.y) * u_zoom;
    gl_Position  = vec4(clip_x, clip_y, 0.0, 1.0);
    gl_PointSize = 10.0;    // fixed size in pixels, whatever the zoom
}
