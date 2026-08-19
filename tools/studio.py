"""Killer House Studio — a control panel for this scene's own toolchain.

Everything in here is a tool that was previously only runnable by hand. It is
all local: it reads the project, runs the same Python scripts, and streams their
output. Nothing needs a network and nothing needs Node.

    python tools/studio.py

WHY THIS EXISTS. The hard part of this scene is not writing the traps, it is
keeping the LETHAL VOLUME and the MODEL ON SCREEN the same object. Every unfair
death this project has had came from those two drifting apart: a capsule around
a flat axe head, a fallback column around a blade that had been deleted, keyframes
pasted into the wrong array. So the tools here are mostly measuring instruments —
bake a shape off the mesh, then prove it against the mesh.

Run the three audits after any change; run Verify after any re-bake or after
moving anything in Creator Hub.
"""
import os
import queue
import subprocess
import sys
import threading
import tkinter as tk
from tkinter import filedialog, ttk
from tkinter.scrolledtext import ScrolledText

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, 'tools')
PY = sys.executable

# ── palette: dark, because the scene is ────────────────────────────────────
BG = '#15161a'
PANEL = '#1d1f25'
EDGE = '#2c2f38'
FG = '#e6e6ea'
DIM = '#9a9daa'
ACCENT = '#c8a24a'      # the scene's WAX colour
OK = '#66c98d'
BAD = '#e0685f'
MONO = ('Consolas', 10)


class Param:
    """One input for a tool. kind: text | file | float | int | check | choice"""

    def __init__(self, flag, label, kind='text', default='', help='', choices=None):
        self.flag = flag
        self.label = label
        self.kind = kind
        self.default = default
        self.help = help
        self.choices = choices or []
        self.var = None


class Tool:
    def __init__(self, name, group, script, blurb, params=None, args=None, slow=False):
        self.name = name
        self.group = group
        self.script = script      # path relative to project root
        self.blurb = blurb
        self.params = params or []
        self.args = args or []    # fixed positional args
        self.slow = slow

    def command(self):
        cmd = [PY, os.path.join(ROOT, self.script)]
        cmd += [a.replace('{ROOT}', ROOT) for a in self.args]
        for p in self.params:
            val = p.var.get() if p.var is not None else p.default
            if p.kind == 'check':
                if val:
                    cmd.append(p.flag)
                continue
            val = str(val).strip()
            if not val:
                continue
            if p.flag:
                cmd.append(p.flag)
                cmd += val.split() if p.kind == 'nargs' else [val]
            else:
                cmd += val.split()
        return cmd


TOOLKIT = [
    Tool('Imports & assets', 'Audit', 'tools/audit.py',
         'Stands in for the TypeScript compiler, which cannot run here. Catches unresolved '
         'imports, names imported but never exported, duplicate exports, asset paths pointing '
         'at files that do not exist, and baked constants that have drifted from the asset '
         'they describe. Run this after every edit.',
         args=['{ROOT}']),

    Tool('Death system', 'Audit', 'tools/audit_deaths.py',
         'Every object that can kill the player, checked. Finds each killPlayer() call by '
         'reading the source, then verifies: the entity it adopts actually exists in the '
         'scene, the kill is gated on invulnerability, the cause strings are sane, and '
         'whether its lethal shape is measured off a model or a hand-written radius.\n\n'
         'This is the check that catches a trap still killing after its model was deleted '
         'from the scene — which is exactly what the old swinging blade was doing.'),

    Tool('Bracket balance', 'Audit', 'tools/balance.py',
         'Cheapest possible signal that an edit did not lose a brace. Strips comments and '
         'string literals with a real scanner (regex cannot nest), then counts. Give it a '
         'list of files.',
         params=[Param('', 'files', 'text',
                       'src/config.ts src/ui.tsx src/traps/swingTraps.ts',
                       'space-separated, relative to the project root')]),

    Tool('Hit fairness', 'Verify', 'tools/verify_hits.py',
         'Replays the SHIPPED kill test against the real animated mesh. Sweeps the player '
         'across a grid on both floors, through each clip, and every time the game says '
         '"kill" it measures how far the model actually was.\n\n'
         'UNFAIR = killed with the model further away than your own body radius.\n'
         'MISSED = the mesh passed through you and nothing happened.\n\n'
         'It reads the keyframes out of swingTrapShapes.ts and the placements out of '
         'main.composite, so it tests what ships. Takes a few minutes.',
         slow=True),

    Tool('Bake hit shapes', 'Build', 'tools/bake_hit_shapes.py',
         'Measures a moving GLB part and emits oriented boxes for the hit test. Picks the '
         'slice count, the cross-section cells and the keyframe times BY MEASUREMENT — it '
         'keeps subdividing while that still removes lethal volume, and keeps inserting '
         'keyframes until the interpolated shape sits within tolerance of the real mesh '
         'surface. Asserts the two invariants the runtime depends on (uniform box count, '
         'ascending t) before writing anything.\n\n'
         'Use "Detect clips" to fill in the clip name and duration.',
         params=[
             Param('--model', 'model (.glb)', 'file', 'assets/Models/pblade2/pblade2.glb'),
             Param('--clip', 'clip name', 'text', 'pbaldeAction'),
             Param('--duration', 'duration (s)', 'float', '3.958'),
             Param('--name', 'TS const name', 'text', 'SWING_TRAP_PBLADE'),
             Param('--tolerance', 'tolerance (m)', 'float', '0.05',
                   'how far the baked shape may sit from the real surface'),
             Param('--cell-width', 'cell width (m)', 'float', '0.5',
                   'smaller hugs a curved blade tighter, at more data'),
             Param('--max-keyframes', 'max keyframes', 'int', '40'),
             Param('--out', 'write to', 'text', 'tools/_baked.txt'),
         ], slow=True),

    Tool('Spike fairness', 'Verify', 'tools/verify_spikes.py',
         'The wall-spike counterpart of Hit fairness. Rebuilds what the trap does - '
         'lerp(hidden, extended, travel), then the model boxes rotated and offset onto '
         'that - and puts the REAL VISIBLE fence at the same pose to measure how far it '
         'really was every time the test said kill.'
         'It also reports, per unit, which way it thrusts and whether ANY floor '
         'intersects its kill volume. That is how 4_6 and 4_7 were found to be inert: '
         'they rest below the ground floor, so nothing they do can reach a player.'),

    Tool('Bake spike boxes', 'Build', 'tools/bake_spike_boxes.py',
         'Re-measures the fence panel kill boxes from the VISIBLE mesh only. '
         'The .glb carries a node called HWN20_IronfFence_04_collider: a solid '
         '3.97 x 3.04 x 0.23m box proxy. The original boxes were measured over the '
         'whole file, so the lethal volume was that slab - thicker than the fence and '
         'solid across an object whose real geometry fills about half its own face. '
         'Rasterise at PLAYER scale (0.20m), not picket scale: gaps narrower than that '
         'are bridged by the player own 0.4m body anyway, so filling them costs '
         'nothing, while the arch at the top is correctly excluded.',
         params=[
             Param('--cell', 'grid cell (m)', 'float', '0.20',
                   '0.20 = player scale; smaller hugs each picket at more boxes'),
             Param('--max-boxes', 'max boxes', 'int', '18'),
             Param('--spacing', 'sample spacing (m)', 'float', '0.015'),
             Param('--out', 'write to', 'text', ''),
         ]),

    Tool('Scene entities', 'Inspect', 'tools/inspect_scene.py',
         'What Creator Hub actually placed, straight out of main.composite: world positions '
         'with the parent chain composed, rotations in BOTH euler degrees and quaternion, '
         'non-uniform scales flagged, missing models flagged.\n\n'
         'Every "the trap kills in the wrong place" bug here has been a mismatch between '
         'what the code assumed and what the transform really was.',
         params=[
             Param('--find', 'name contains', 'text', 'pblade'),
             Param('--near', 'near x y z', 'nargs', '', 'e.g. 10.07 0 23.24'),
             Param('--radius', 'radius (m)', 'float', '3'),
             Param('--anim', 'list animation clips', 'check', True),
             Param('--components', 'list other components', 'check', False),
         ]),

    Tool('Wood impact', 'Sound', 'wood-source/make_wood_impact.py',
         'The plank landing. Contact crack + the board\'s own struck-bar modes (inharmonic, '
         'which is why it reads as wood and not a note) + a floor thump + a settling rattle. '
         'Seeded, so re-running is byte-identical. Prints peak, DC offset, clipped-sample '
         'count and the RMS decay so you can tell it is clean without listening.'),

    Tool('Force field hit', 'Sound', 'forcefield-source/make_forcefield_sound.py',
         'The web triggering when you leave the plot. Same approach as the wood impact: '
         'stdlib synthesis, seeded, with the same measured report at the end.'),
]


class Studio(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title('Killer House Studio')
        self.geometry('1180x780')
        self.minsize(940, 620)
        self.configure(bg=BG)
        self.proc = None
        self.q = queue.Queue()

        self._style()
        self._build()
        self.after(60, self._drain)

    # ── chrome ─────────────────────────────────────────────────────────────
    def _style(self):
        st = ttk.Style(self)
        try:
            st.theme_use('clam')
        except tk.TclError:
            pass
        st.configure('.', background=BG, foreground=FG, fieldbackground=PANEL,
                     bordercolor=EDGE, lightcolor=PANEL, darkcolor=PANEL)
        st.configure('TFrame', background=BG)
        st.configure('Panel.TFrame', background=PANEL)
        st.configure('TLabel', background=BG, foreground=FG)
        st.configure('Dim.TLabel', background=BG, foreground=DIM)
        st.configure('Head.TLabel', background=BG, foreground=ACCENT,
                     font=('Segoe UI Semibold', 13))
        st.configure('Group.TLabel', background=BG, foreground=DIM,
                     font=('Segoe UI', 8, 'bold'))
        st.configure('TButton', background=EDGE, foreground=FG, borderwidth=0, padding=(14, 7))
        st.map('TButton', background=[('active', '#3a3e4a'), ('disabled', '#22242b')])
        st.configure('Go.TButton', background=ACCENT, foreground='#15161a',
                     font=('Segoe UI Semibold', 10), padding=(18, 8))
        st.map('Go.TButton', background=[('active', '#dcb45c'), ('disabled', '#5d5238')])
        st.configure('TEntry', fieldbackground=PANEL, foreground=FG, insertcolor=FG,
                     bordercolor=EDGE, padding=5)
        st.configure('TCheckbutton', background=BG, foreground=FG)
        st.map('TCheckbutton', background=[('active', BG)])
        st.configure('TNotebook', background=BG, borderwidth=0)
        st.configure('TNotebook.Tab', background=PANEL, foreground=DIM, padding=(16, 8))
        st.map('TNotebook.Tab', background=[('selected', BG)], foreground=[('selected', ACCENT)])

    def _build(self):
        head = ttk.Frame(self, padding=(16, 12, 16, 6))
        head.pack(fill='x')
        ttk.Label(head, text='Killer House Studio', style='Head.TLabel').pack(side='left')
        ttk.Label(head, text='  local toolchain — no network, no Node',
                  style='Dim.TLabel').pack(side='left', padx=(8, 0))
        self.status = ttk.Label(head, text='idle', style='Dim.TLabel')
        self.status.pack(side='right')

        body = ttk.Frame(self, padding=(12, 0, 12, 12))
        body.pack(fill='both', expand=True)

        # left: the tool list
        left = ttk.Frame(body, style='Panel.TFrame', padding=8)
        left.pack(side='left', fill='y')
        self.listbox = tk.Listbox(left, width=26, bg=PANEL, fg=FG, bd=0,
                                  highlightthickness=0, activestyle='none',
                                  selectbackground=EDGE, selectforeground=ACCENT,
                                  font=('Segoe UI', 10))
        self.listbox.pack(fill='y', expand=True)
        self.rowmap = {}
        last = None
        for i, t in enumerate(TOOLKIT):
            if t.group != last:
                self.listbox.insert('end', '  %s' % t.group.upper())
                self.listbox.itemconfig('end', foreground=DIM)
                last = t.group
            self.listbox.insert('end', '   %s' % t.name)
            self.rowmap[self.listbox.size() - 1] = t
        self.listbox.bind('<<ListboxSelect>>', self._select)

        # right: notebook with Run + Reference
        right = ttk.Frame(body)
        right.pack(side='left', fill='both', expand=True, padx=(12, 0))
        nb = ttk.Notebook(right)
        nb.pack(fill='both', expand=True)

        run_tab = ttk.Frame(nb, padding=12)
        nb.add(run_tab, text='Run')
        ref_tab = ttk.Frame(nb, padding=0)
        nb.add(ref_tab, text='Method')

        self.blurb = tk.Text(run_tab, height=7, wrap='word', bg=BG, fg=DIM, bd=0,
                             highlightthickness=0, font=('Segoe UI', 10), padx=0, pady=0)
        self.blurb.pack(fill='x')
        self.blurb.configure(state='disabled')

        self.paramframe = ttk.Frame(run_tab)
        self.paramframe.pack(fill='x', pady=(10, 8))

        bar = ttk.Frame(run_tab)
        bar.pack(fill='x', pady=(0, 8))
        self.runbtn = ttk.Button(bar, text='Run', style='Go.TButton', command=self._run)
        self.runbtn.pack(side='left')
        self.stopbtn = ttk.Button(bar, text='Stop', command=self._stop, state='disabled')
        self.stopbtn.pack(side='left', padx=6)
        self.clipsbtn = ttk.Button(bar, text='Detect clips', command=self._detect_clips)
        self.clipsbtn.pack(side='left', padx=6)
        ttk.Button(bar, text='Clear', command=lambda: self._clear()).pack(side='right')
        self.cmdlabel = ttk.Label(run_tab, text='', style='Dim.TLabel', font=('Consolas', 8))
        self.cmdlabel.pack(fill='x', pady=(0, 6))

        self.out = ScrolledText(run_tab, bg='#0f1013', fg='#cfd2da', bd=0,
                                highlightthickness=0, font=MONO, wrap='none',
                                insertbackground=FG)
        self.out.pack(fill='both', expand=True)
        self.out.tag_config('ok', foreground=OK)
        self.out.tag_config('bad', foreground=BAD)
        self.out.tag_config('meta', foreground=ACCENT)

        ref = ScrolledText(ref_tab, bg=BG, fg=FG, bd=0, highlightthickness=0,
                           font=('Segoe UI', 10), wrap='word', padx=16, pady=14)
        ref.pack(fill='both', expand=True)
        ref.insert('1.0', REFERENCE)
        ref.configure(state='disabled')

        self.listbox.selection_set(1)
        self._select()

    # ── behaviour ──────────────────────────────────────────────────────────
    def _current(self):
        sel = self.listbox.curselection()
        if not sel:
            return None
        return self.rowmap.get(sel[0])

    def _select(self, _evt=None):
        t = self._current()
        for w in self.paramframe.winfo_children():
            w.destroy()
        if t is None:
            return
        self.blurb.configure(state='normal')
        self.blurb.delete('1.0', 'end')
        self.blurb.insert('1.0', t.blurb)
        self.blurb.configure(state='disabled')
        self.clipsbtn.configure(state='normal' if any(p.flag == '--model' for p in t.params)
                                else 'disabled')
        for r, p in enumerate(t.params):
            ttk.Label(self.paramframe, text=p.label, style='Dim.TLabel').grid(
                row=r, column=0, sticky='w', pady=3, padx=(0, 10))
            if p.kind == 'check':
                p.var = tk.BooleanVar(value=bool(p.default))
                ttk.Checkbutton(self.paramframe, variable=p.var).grid(row=r, column=1, sticky='w')
            else:
                p.var = tk.StringVar(value=str(p.default))
                e = ttk.Entry(self.paramframe, textvariable=p.var, width=58)
                e.grid(row=r, column=1, sticky='we', pady=3)
                if p.kind == 'file':
                    ttk.Button(self.paramframe, text='...', width=3,
                               command=lambda pp=p: self._pick(pp)).grid(row=r, column=2, padx=4)
            if p.help:
                ttk.Label(self.paramframe, text=p.help, style='Dim.TLabel',
                          font=('Segoe UI', 8)).grid(row=r, column=3, sticky='w', padx=8)
        self.paramframe.columnconfigure(1, weight=1)
        self._show_cmd()

    def _pick(self, p):
        f = filedialog.askopenfilename(initialdir=os.path.join(ROOT, 'assets'),
                                       filetypes=[('glTF binary', '*.glb'), ('all', '*.*')])
        if f:
            try:
                f = os.path.relpath(f, ROOT).replace('\\', '/')
            except ValueError:
                pass
            p.var.set(f)
            self._show_cmd()

    def _show_cmd(self):
        t = self._current()
        if t is None:
            return
        cmd = t.command()
        pretty = ' '.join(('"%s"' % c if ' ' in c else c) for c in cmd[1:])
        self.cmdlabel.configure(text='python ' + pretty)

    def _clear(self):
        self.out.delete('1.0', 'end')

    def _write(self, line):
        tag = ''
        low = line.lower()
        if any(k in line for k in ('PROBLEM', 'MISSING', 'UNBALANCED', 'Traceback',
                                   'Error', 'error:', 'NOT GATED', 'UNFAIR')):
            tag = 'bad'
        elif any(k in low for k in ('no problems', 'no unresolved', 'found', ' ok', 'written',
                                    'verified', '-> ')):
            tag = 'ok'
        elif line.startswith('==') or line.startswith('--'):
            tag = 'meta'
        self.out.insert('end', line, tag)
        self.out.see('end')

    def _run(self, override=None):
        if self.proc is not None:
            return
        t = self._current()
        if t is None and override is None:
            return
        cmd = override or t.command()
        self._show_cmd()
        self._write('\n$ python %s\n' % ' '.join(cmd[1:]))
        if t is not None and t.slow and override is None:
            self._write('  (this one measures a lot of geometry — expect minutes)\n')
        self.runbtn.configure(state='disabled')
        self.stopbtn.configure(state='normal')
        self.status.configure(text='running…', foreground=ACCENT)
        try:
            self.proc = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE,
                                         stderr=subprocess.STDOUT, text=True,
                                         encoding='utf-8', errors='replace', bufsize=1)
        except OSError as e:
            self._write('could not start: %s\n' % e)
            self._done(-1)
            return
        threading.Thread(target=self._pump, args=(self.proc,), daemon=True).start()

    def _pump(self, proc):
        for line in iter(proc.stdout.readline, ''):
            self.q.put(('line', line))
        proc.stdout.close()
        self.q.put(('exit', proc.wait()))

    def _drain(self):
        try:
            while True:
                kind, payload = self.q.get_nowait()
                if kind == 'line':
                    self._write(payload)
                else:
                    self._done(payload)
        except queue.Empty:
            pass
        self.after(60, self._drain)

    def _done(self, code):
        self.proc = None
        self.runbtn.configure(state='normal')
        self.stopbtn.configure(state='disabled')
        good = code == 0
        self.status.configure(text='exit %s' % code, foreground=OK if good else BAD)
        self._write('[exit %s]\n' % code)

    def _stop(self):
        if self.proc is not None:
            self.proc.terminate()
            self._write('[stopped]\n')

    def _detect_clips(self):
        """List the animation clips in the chosen .glb, with their lengths."""
        t = self._current()
        if t is None:
            return
        model = next((p.var.get() for p in t.params if p.flag == '--model'), '')
        if not model:
            return
        code = (
            'import sys,os;sys.path.insert(0,%r);import glbkit as G;'
            'g,bn=G.load(os.path.join(G.ROOT,%r));'
            'ans=[(a.get("name"),max([v[0] for s in a["samplers"] '
            'for v in G.acc(g,bn,s["input"])]+[0])) for a in g.get("animations",[])];'
            'print("clips in %s:");'
            '[print("   %%-34s %%.3fs" %% (n,d)) for n,d in ans] or print("   (none)")'
            % (TOOLS, model, model)
        )
        self._run([PY, '-c', code])


REFERENCE = """THE METHOD

The whole difficulty of this scene is keeping two things identical: the volume
that kills the player, and the model they can see. Every unfair death this
project has shipped came from those drifting apart.

MEASURE, DO NOT ESTIMATE
    No kill volume is hand-written if the model can be measured instead. The
    wall spikes are eight boxes taken off the fence mesh. The plank and axe are
    oriented boxes baked from their animation clips. When a number IS hand
    written — the chandelier's radius, the skeleton's reach — the death audit
    lists it explicitly so it is a visible decision rather than a hidden one.

A CAPSULE IS THE WRONG SHAPE FOR ANYTHING FLAT
    A capsule takes the widest perpendicular extent of what it wraps. The axe
    head measures 2.69m across and 0.24m thick, so as a capsule it becomes a
    2.74m cylinder and kills people a clear metre off the flat of the blade.
    Oriented boxes keep the thinness. Measured: 86% less lethal air than an
    axis-aligned box around the same pose.

AN AXIS-ALIGNED BOX IS THE WRONG SHAPE FOR ANYTHING THAT TURNS
    It balloons as the thing inside it rotates. Mid-swing the plank's box was
    20.8 m3 around a 3.4 m3 board.

BOXES MUST BE SAFE TO INTERPOLATE
    The runtime lerps box i of one keyframe against box i of the next. Two
    invariants make that meaningful, and both are asserted by the baker:
      * every keyframe carries the same number of boxes, in the same order,
        ordered from the model's pivot outwards. An early bake let the chain
        flip end-for-end, so interpolation lerped the axe's HEAD into its
        HANDLE and put a multi-metre phantom in the middle of the swing;
      * t ascends. A mis-paste once left a non-monotonic list, and the lookup
        silently returned the wrong pose for a third of the clip.

SAMPLE BY AREA, NEVER PER TRIANGLE
    The plank is 16 triangles. A fixed sample count per triangle puts points
    ~2m apart on an 8m board, and then every measurement taken against them is
    blind to the very thing it is measuring. This bit me directly: a bake
    "verified" against sparse samples chose 8 slices as tighter, when what it
    had actually found was holes.

VERIFY AGAINST THE MESH, NOT AGAINST THE FIT
    Volume ratios are a proxy. Verify > Hit fairness replays the real kill test
    over ~23,500 player positions per unit and measures how far the model
    actually was each time the game said "kill". That is the number that
    matters, and it is the one that found the residual crescent-corner slack in
    the axe head after the volumes already looked good.

WHAT MEASUREMENT CANNOT SEE
    Two bugs got through every geometric check because they were not geometry:
      * a trap whose entity had been deleted from the scene, still killing via
        a fallback shape — now caught by Audit > Death system;
      * an animation restarting because shouldReset was left true, so the plank
        snapped back up the instant it landed. Engine state, not shape. The only
        tool for that class is reading the component you are mutating.
"""


if __name__ == '__main__':
    Studio().mainloop()
