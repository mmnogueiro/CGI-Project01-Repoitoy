import { loadShadersFromURLS, buildProgramFromSources, setupWebGL } from "../../libs/utils.js";

/** @type {HTMLCanvasElement} */
let canvas;
/** @type {WebGL2RenderingContext} */
let gl;

// --- WebGL objects ----------------------------------------------------------
let program;            // draws the full-screen quad
let quad_vao;           // the quad covering the whole viewport
let site_program;       // draws the site markers
let site_vao;           // VAO for the site markers
let site_buffer;        // site positions, re-uploaded every frame

// Uniform locations of site_program (looked up once, in setup)
let u_site_pan;
let u_site_zoom;
let u_site_aspect;

// --- Sites ------------------------------------------------------------------
const MAX_SITES = 32;   // must match MAX_SITES in the shaders that read the sites
let sites = [];         // each site: { pos: [x, y] (world coords), color: [r, g, b] }

// --- View (world <-> screen) ------------------------------------------------
let pan = { x: 0.0, y: 0.0 };   // world offset, in world units
let zoom = 1.0;                 // scale factor (> 1 = zoomed in)
const ZOOM_STEP = 1.1;          // each wheel notch zooms in/out by 10%
const MIN_ZOOM = 0.01;          // zoom limits, to avoid floating-point precision problems
const MAX_ZOOM = 1000.0;

// --- Mouse state ------------------------------------------------------------
const DRAG_THRESHOLD = 4;       // pixels: below this a click is still a click
const PICK_RADIUS = 10;         // pixels: how close the pointer must be to grab a site
let mouse_down = false;         // is the button currently pressed?
let moved = false;              // has it moved more than DRAG_THRESHOLD since it was pressed?
let down_x = 0, down_y = 0;     // where it was pressed (canvas pixels)
let last_x = 0, last_y = 0;     // previous position while pressed (canvas pixels), for panning
let pointer_x = 0, pointer_y = 0;   // current position, always up to date (used by 'x')
let dragged_site = -1;          // index of the site being dragged, or -1 if none
let drag_offset = [0.0, 0.0];   // site position minus pointer position (world), so it doesn't jump


// ---------------------------------------------------------------------------
// Input. Mouse positions are in canvas pixels, with (0, 0) at the top-left
// corner and y growing downwards.
// ---------------------------------------------------------------------------

function on_mouse_down(x, y) {
    mouse_down = true;
    moved = false;
    down_x = x;
    down_y = y;
    last_x = x;
    last_y = y;

    // Did the press land on a site? If so, remember where in the site it was grabbed
    dragged_site = find_site_near(x, y, PICK_RADIUS);
    if (dragged_site >= 0) {
        const [wx, wy] = screen_to_world(x, y);
        drag_offset = [sites[dragged_site].pos[0] - wx, sites[dragged_site].pos[1] - wy];
    }
}

function on_mouse_move(x, y) {
    // Always track the pointer, even with no button pressed
    pointer_x = x;
    pointer_y = y;

    if (!mouse_down) return;

    if (Math.hypot(x - down_x, y - down_y) > DRAG_THRESHOLD) {
        moved = true;
    }

    if (moved) {
        if (dragged_site >= 0) {
            // Dragging a site: it follows the pointer, keeping the grab offset
            const [wx, wy] = screen_to_world(x, y);
            sites[dragged_site].pos = [wx + drag_offset[0], wy + drag_offset[1]];
        } else {
            // Dragging empty canvas: pan so the world follows the pointer
            const [ax, ay] = screen_to_world(last_x, last_y);
            const [bx, by] = screen_to_world(x, y);
            pan.x += bx - ax;
            pan.y += by - ay;
        }
    }

    last_x = x;
    last_y = y;
}

function on_mouse_up(x, y) {
    if (!mouse_down) return;
    mouse_down = false;

    // A click (no drag) on empty canvas adds a site, if there is room for one
    if (!moved && dragged_site < 0 && sites.length < MAX_SITES) {
        sites.push({ pos: screen_to_world(x, y), color: get_random_color() });
    }

    dragged_site = -1;
}

// dy > 0 when the wheel is scrolled down (towards the user)
function on_wheel(x, y, dy) {
    const [bx, by] = screen_to_world(x, y);     // world point under the pointer before zooming

    zoom *= (dy > 0) ? 1.0 / ZOOM_STEP : ZOOM_STEP;     // wheel down = zoom out
    zoom = Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);

    // Shift the view so that the same world point stays under the pointer
    const [ax, ay] = screen_to_world(x, y);
    pan.x += ax - bx;
    pan.y += ay - by;
}

function on_key(key) {
    switch (key) {
        case '1':       // Euclidean distance
            break;
        case '2':       // Manhattan distance
            break;
        case '3':       // Chebyshev distance
            break;
        case 'b':       // toggle cell borders
            break;
        case 'x': {     // remove the site nearest the pointer
            if (mouse_down) break;      // not in the middle of a drag (indices would shift)
            const i = find_site_near(pointer_x, pointer_y);
            if (i >= 0) sites.splice(i, 1);
            break;
        }
        case 'm':       // switch rendering technique / split view
            break;
    }
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Returns a random colour for a new site
function get_random_color() {
    return [Math.random(), Math.random(), Math.random()];
}

// Converts a canvas pixel (y growing downwards) into world coordinates.
// This is the exact inverse of the world -> clip transform in site.vert.
function screen_to_world(px, py) {
    const aspect = canvas.width / canvas.height;

    // 1. Pixels -> normalized device coordinates, from -1 to 1 (y flipped)
    const ndc_x = (2.0 * px / canvas.width) - 1.0;
    const ndc_y = 1.0 - (2.0 * py / canvas.height);

    // 2. Undo the aspect ratio correction (x only), the zoom and the pan
    const world_x = (ndc_x * aspect) / zoom - pan.x;
    const world_y = ndc_y / zoom - pan.y;

    return [world_x, world_y];
}

// Index of the site closest to pixel (x, y), or -1 if none is within max_px pixels
function find_site_near(x, y, max_px = Infinity) {
    const [wx, wy] = screen_to_world(x, y);
    const world_per_px = 2.0 / (canvas.height * zoom);  // size of one pixel, in world units

    let best = -1;
    let best_d = max_px * world_per_px;                 // search radius, in world units
    for (let i = 0; i < sites.length; i++) {
        const d = Math.hypot(sites[i].pos[0] - wx, sites[i].pos[1] - wy);
        if (d < best_d) {
            best = i;
            best_d = d;
        }
    }
    return best;
}


// ---------------------------------------------------------------------------

function resize() {
    // Match the canvas's drawing buffer to the size it is shown at, and
    // draw over all of it
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
}

function setup_input() {
    canvas.addEventListener("mousedown", (event) => on_mouse_down(event.offsetX, event.offsetY));
    canvas.addEventListener("mousemove", (event) => on_mouse_move(event.offsetX, event.offsetY));
    window.addEventListener("mouseup", (event) => on_mouse_up(event.offsetX, event.offsetY));
    canvas.addEventListener("wheel", (event) => {
        on_wheel(event.offsetX, event.offsetY, event.deltaY);
        event.preventDefault();     // don't let the page scroll as well
    });
    window.addEventListener("keydown", (event) => on_key(event.key));
}

function setup(shaders) {
    canvas = document.getElementById("gl-canvas");
    gl = setupWebGL(canvas);

    program = buildProgramFromSources(gl, shaders["quad.vert"], shaders["quad.frag"]);
    site_program = buildProgramFromSources(gl, shaders["site.vert"], shaders["site.frag"]);

    // --- Quad ---------------------------------------------------------------
    // A quad covering the whole viewport, as two triangles: its corners are
    // the corners of clip space, from (-1, -1) to (1, 1)
    const corners = new Float32Array([
        -1, -1,     1, -1,     1, 1,       // first triangle
        -1, -1,     1, 1,     -1, 1,       // second triangle
    ]);

    quad_vao = gl.createVertexArray();
    gl.bindVertexArray(quad_vao);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW);

    const a_position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(a_position);
    gl.vertexAttribPointer(a_position, 2, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);

    // --- Site markers -------------------------------------------------------
    site_vao = gl.createVertexArray();
    gl.bindVertexArray(site_vao);

    // Room for MAX_SITES positions: 2 floats (x, y) per site, 4 bytes per float.
    // Filled in every frame with bufferSubData, since sites change all the time.
    site_buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, site_buffer);
    gl.bufferData(gl.ARRAY_BUFFER, MAX_SITES * 2 * 4, gl.DYNAMIC_DRAW);

    const a_site_position = gl.getAttribLocation(site_program, "a_position");
    gl.enableVertexAttribArray(a_site_position);
    gl.vertexAttribPointer(a_site_position, 2, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);

    u_site_pan = gl.getUniformLocation(site_program, "u_pan");
    u_site_zoom = gl.getUniformLocation(site_program, "u_zoom");
    u_site_aspect = gl.getUniformLocation(site_program, "u_aspect");

    // --- Window and input ---------------------------------------------------
    resize();
    window.addEventListener("resize", resize);
    setup_input();

    gl.clearColor(0.0, 0.0, 0.0, 1.0);

    window.requestAnimationFrame(animate);
}

function animate(timestamp) {
    window.requestAnimationFrame(animate);

    gl.clear(gl.COLOR_BUFFER_BIT);

    // --- 1st draw: the full-screen quad (background) ------------------------
    gl.useProgram(program);
    gl.bindVertexArray(quad_vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    gl.useProgram(null);

    // --- 2nd draw: the site markers, on top ---------------------------------
    // Upload the current positions, flattened as [x0, y0, x1, y1, ...]
    const positions = new Float32Array(sites.flatMap(s => s.pos));
    gl.bindBuffer(gl.ARRAY_BUFFER, site_buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions);

    // Same view parameters as screen_to_world, so clicks and drawing agree
    gl.useProgram(site_program);
    gl.uniform2f(u_site_pan, pan.x, pan.y);
    gl.uniform1f(u_site_zoom, zoom);
    gl.uniform1f(u_site_aspect, canvas.width / canvas.height);

    gl.bindVertexArray(site_vao);
    gl.drawArrays(gl.POINTS, 0, sites.length);
    gl.bindVertexArray(null);
    gl.useProgram(null);
}

loadShadersFromURLS(["quad.vert", "quad.frag", "site.vert", "site.frag"]).then(shaders => setup(shaders));
