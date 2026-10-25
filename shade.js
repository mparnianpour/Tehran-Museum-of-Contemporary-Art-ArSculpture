// shade.js
// The Turrell walls shader, cut down to its Shade: the camera view dims (Shade fixed at 55%),
// cools into the deep blue of a projector-lit haze, and the room's light flickers.
// Everything three.js draws afterwards (the sculpture, the projector beams) is untouched by it.
//
// Usage with the 8th Wall engine:
//   const shade = Shade.pipelineModule()
//   XR8.addCameraPipelineModules([XR8.GlTextureRenderer.pipelineModule(), shade, XR8.Threejs.pipelineModule(), ...])
//   shade.light   // this frame's room light (1 = steady), to light the sculpture in step with the room

(function () {
  const SHADE = 0.55                   // the Turrell "Shade" setting, fixed at 55%
  const FLICKER = 0.6                  // 0..1  how unsteady the room light is
  const AMBIENCE = [0.424, 0.586, 0.97]   // the colour the dimmed room takes on: deep blue, 10% toward sunlight
  const COOL = 0.55                    // 0..1  how far the room is drawn into that colour

  // On-screen pass: same mapping as 8th Wall's camera renderer (top of screen = uv.y 0).
  const VS_SCREEN = `
attribute vec2 position;
varying vec2 uv;
void main() { uv = vec2(position.x * 0.5 + 0.5, 0.5 - position.y * 0.5); gl_Position = vec4(position, 0.0, 1.0); }`

  const FS_SHADE = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 uv;
uniform sampler2D cam;
uniform float shade;       // 0..1 darkens the whole camera view
uniform float light;       // current flicker multiplier (computed on the CPU each frame)
uniform vec3 ambience;
uniform float cool;
void main() {
  vec3 orig = texture2D(cam, uv).rgb;
  float lum = dot(orig, vec3(0.299, 0.587, 0.114));
  vec3 outc = mix(orig, min(lum * ambience * 1.3, vec3(1.0)), cool);
  outc *= (1.0 - shade * 0.85) * light;
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  outc += (n - 0.5) / 255.0;                       // dither: no banding in the dark
  gl_FragColor = vec4(outc, 1.0);
}`

  // ---------- renderer (usable on its own, e.g. for testing with a still image) ----------
  function createRenderer(gl) {
    const isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext
    const vaoExt = isGL2 ? null : gl.getExtension('OES_vertex_array_object')
    const createVAO = () => (isGL2 ? gl.createVertexArray() : vaoExt ? vaoExt.createVertexArrayOES() : null)
    const bindVAO = (v) => (isGL2 ? gl.bindVertexArray(v) : vaoExt ? vaoExt.bindVertexArrayOES(v) : null)
    const VAO_BINDING = isGL2 ? gl.VERTEX_ARRAY_BINDING : vaoExt ? vaoExt.VERTEX_ARRAY_BINDING_OES : null

    const compile = (vs, fs) => {
      const mk = (type, src) => {
        const s = gl.createShader(type)
        gl.shaderSource(s, src)
        gl.compileShader(s)
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('[Shade] shader: ' + gl.getShaderInfoLog(s))
        return s
      }
      const p = gl.createProgram()
      gl.attachShader(p, mk(gl.VERTEX_SHADER, vs))
      gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs))
      gl.bindAttribLocation(p, 0, 'position')
      gl.linkProgram(p)
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('[Shade] link: ' + gl.getProgramInfoLog(p))
      const u = {}
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS)
      for (let i = 0; i < n; i++) {
        const name = gl.getActiveUniform(p, i).name
        u[name] = gl.getUniformLocation(p, name)
      }
      return {p, u}
    }

    // --- save / restore everything we touch, so the engine and three.js are unaffected
    const save = () => {
      const s = {
        program: gl.getParameter(gl.CURRENT_PROGRAM),
        fb: gl.getParameter(gl.FRAMEBUFFER_BINDING),
        viewport: gl.getParameter(gl.VIEWPORT),
        active: gl.getParameter(gl.ACTIVE_TEXTURE),
        buffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
        vao: VAO_BINDING ? gl.getParameter(VAO_BINDING) : null,
        blend: gl.isEnabled(gl.BLEND),
        depth: gl.isEnabled(gl.DEPTH_TEST),
        cull: gl.isEnabled(gl.CULL_FACE),
        scissor: gl.isEnabled(gl.SCISSOR_TEST),
        stencil: gl.isEnabled(gl.STENCIL_TEST),
        mask: gl.getParameter(gl.COLOR_WRITEMASK),
      }
      gl.activeTexture(gl.TEXTURE0)
      s.tex0 = gl.getParameter(gl.TEXTURE_BINDING_2D)
      return s
    }
    const restore = (s) => {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, s.tex0)
      gl.activeTexture(s.active)
      gl.useProgram(s.program)
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.fb)
      gl.viewport(s.viewport[0], s.viewport[1], s.viewport[2], s.viewport[3])
      bindVAO(s.vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, s.buffer)
      const en = (cap, on) => (on ? gl.enable(cap) : gl.disable(cap))
      en(gl.BLEND, s.blend); en(gl.DEPTH_TEST, s.depth); en(gl.CULL_FACE, s.cull)
      en(gl.SCISSOR_TEST, s.scissor); en(gl.STENCIL_TEST, s.stencil)
      gl.colorMask(s.mask[0], s.mask[1], s.mask[2], s.mask[3])
    }

    const st0 = save()
    const prog = compile(VS_SCREEN, FS_SHADE)
    const vao = createVAO()
    bindVAO(vao)
    const quad = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    restore(st0)

    // cameraTexture: WebGLTexture, viewport: {offsetX, offsetY, width, height} where the camera
    // image is drawn on the canvas, light: the room light this frame (see flicker below)
    const render = ({cameraTexture, viewport, light = 1, targetFramebuffer = null}) => {
      if (!cameraTexture) return
      const s = save()
      bindVAO(vao)
      if (!vaoExt && !isGL2) {
        gl.bindBuffer(gl.ARRAY_BUFFER, quad)
        gl.enableVertexAttribArray(0)
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
      }
      gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE)
      gl.disable(gl.SCISSOR_TEST); gl.disable(gl.STENCIL_TEST)
      gl.colorMask(true, true, true, true)

      gl.useProgram(prog.p)
      gl.bindFramebuffer(gl.FRAMEBUFFER, targetFramebuffer)
      gl.viewport(viewport.offsetX || 0, viewport.offsetY || 0, viewport.width, viewport.height)
      const u = prog.u
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, cameraTexture)
      gl.uniform1i(u.cam, 0)
      gl.uniform1f(u.shade, SHADE)
      gl.uniform1f(u.light, light)
      gl.uniform3f(u.ambience, AMBIENCE[0], AMBIENCE[1], AMBIENCE[2])
      gl.uniform1f(u.cool, COOL)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

      restore(s)
    }
    return {render}
  }

  // Flicker: a light that never quite holds still. Random brightness targets every
  // 60-200 ms, eased toward, a slow "breathing" wobble, and the odd quick dip.
  function createFlicker(amount) {
    let level = 1
    let target = 1
    let next = 0
    let dipFrames = 0
    return (now) => {
      if (now >= next) {
        target = 1 - Math.random() * 0.55 * amount
        next = now + 60 + Math.random() * 140
      }
      level += (target - level) * 0.35
      if (dipFrames > 0) dipFrames--
      else if (Math.random() < 0.012 * amount) dipFrames = 1 + Math.floor(Math.random() * 3)
      const breathe = Math.sin(now * 0.0123) * 0.5 + Math.sin(now * 0.0371 + 1.3) * 0.5
      const dip = dipFrames > 0 ? 1 - 0.45 * amount : 1
      return Math.max(0, level * (1 + breathe * 0.07 * amount) * dip)
    }
  }

  // ---------- 8th Wall camera pipeline module ----------
  function pipelineModule() {
    let renderer = null
    let camTex = null
    let videoW = 0
    let videoH = 0
    let canvasW = 0
    let canvasH = 0
    const flicker = createFlicker(FLICKER)
    const sizes = ({videoWidth, videoHeight, canvasWidth, canvasHeight}) => {
      if (videoWidth) videoW = videoWidth
      if (videoHeight) videoH = videoHeight
      if (canvasWidth) canvasW = canvasWidth
      if (canvasHeight) canvasH = canvasHeight
    }
    const mod = {
      name: 'shade',
      light: 1,
      onAttach: (args) => {
        sizes(args)
        try {
          renderer = createRenderer(args.GLctx)
        } catch (e) {
          console.error(e)
          if (mod.onError) mod.onError(e)
        }
      },
      onDetach: () => { renderer = null; camTex = null },
      onCanvasSizeChange: sizes,
      onVideoSizeChange: sizes,
      onUpdate: ({frameStartResult, processCpuResult}) => {
        const reality = processCpuResult && processCpuResult.reality
        const t = (reality && reality.realityTexture) || (frameStartResult && frameStartResult.cameraTexture)
        if (t) camTex = t
        mod.light = flicker(performance.now())
      },
      onRender: () => {
        if (!renderer || !camTex || !videoW || !canvasW) return
        const viewport = XR8.GlTextureRenderer.fillTextureViewport(videoW, videoH, canvasW, canvasH)
        renderer.render({cameraTexture: camTex, viewport, light: mod.light})
      },
      onError: null,
    }
    return mod
  }

  window.Shade = {pipelineModule, createRenderer, createFlicker, SHADE, FLICKER}
})()
