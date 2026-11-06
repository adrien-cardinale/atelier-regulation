(function (App) {
  const CODE = String.raw`# =====================================================================
#  Régulateur PID discret : asservissement de position
#  d'un système masse-ressort-amortisseur
# =====================================================================
#
#  Contrat avec la page : simulate(p) -> dict de listes / tableaux.
#  Les marqueurs « # >>> block: ... » relient le code aux blocs du schéma.
#
#  Boucle fermée, à chaque pas k :
#      consigne r  ->  erreur e = r - y_m  ->  PID  ->  commande u
#      ->  système (position y)  ->  capteur (mesure y_m)  ->  retour
# =====================================================================

import numpy as np


# >>> block: setpoint
# ---------------------------------------------------------------------
#  Consigne : un échelon d'amplitude r0 appliqué dès t = 0
# ---------------------------------------------------------------------
def setpoint(t, r0):
    return np.full_like(t, r0)
# <<< block: setpoint


# >>> block: error
# ---------------------------------------------------------------------
#  Comparateur : écart entre la consigne et la MESURE (pas la vraie sortie)
# ---------------------------------------------------------------------
def tracking_error(r, y_meas):
    return r - y_meas
# <<< block: error


# >>> block: pid
# ---------------------------------------------------------------------
#  Correcteur PID discret avec saturation de la commande
# ---------------------------------------------------------------------
#      P = Kp · e                    réagit à l'erreur présente
#      I = Ki · Σ e·dt               annule l'erreur statique (mémoire)
#      D = −Kd · (y_m − y_m_prec)/dt amortit (anticipe la tendance)
#      u = sat(P + I + D, ±u_max)
#
#  La dérivée porte sur la mesure et non sur l'erreur : on évite ainsi
#  le « coup de dérivée » quand la consigne change brutalement.
#
#  Anti-windup (intégration conditionnelle) : quand la commande sature
#  et que l'erreur pousse encore dans le même sens, on gèle l'intégrale.
#  Sans cela, l'intégrale « se charge » et provoque un gros dépassement.

def pid_step(e, y_meas, y_meas_prev, integral, p, dt):
    P = p["Kp"] * e
    D = -p["Kd"] * (y_meas - y_meas_prev) / dt
    candidate = integral + e * dt
    u_raw = P + p["Ki"] * candidate + D
    u = float(np.clip(u_raw, -p["u_max"], p["u_max"]))

    pushing_further = u != u_raw and np.sign(e) == np.sign(u_raw)
    if p["antiwindup"] >= 0.5 and pushing_further:
        candidate = integral

    I = p["Ki"] * candidate
    return u, u_raw, P, I, D, candidate
# <<< block: pid


# >>> block: plant
# ---------------------------------------------------------------------
#  Système commandé : masse-ressort-amortisseur
# ---------------------------------------------------------------------
#      m·ÿ + c·ẏ + k·y = u + d(t)
#
#  d(t) est une perturbation en échelon (force extérieure) appliquée à
#  t = t_pert. Intégration par Euler semi-implicite : on met à jour la
#  vitesse, puis la position avec la nouvelle vitesse (plus stable).

def disturbance(t, p):
    return np.where(t >= p["t_pert"], p["d_amp"], 0.0)


def plant_step(y, v, u, d, p, dt):
    accel = (u + d - p["c"] * v - p["k"] * y) / p["m"]
    v = v + accel * dt
    y = y + v * dt
    return y, v
# <<< block: plant


# >>> block: sensor
# ---------------------------------------------------------------------
#  Capteur de position (bruit blanc optionnel)
# ---------------------------------------------------------------------
#  Un bruit de mesure est amplifié par le terme dérivé : observez D !
def sensor(y, sigma, rng):
    return y + sigma * rng.standard_normal()
# <<< block: sensor


def simulate(p):
    dt = float(p["dt"])
    n = int(p["N"])
    t = np.arange(n) * dt
    rng = np.random.default_rng(0)

    r = setpoint(t, p["setpoint"])
    d = disturbance(t, p)

    names = ["y", "y_meas", "e", "u", "u_raw", "P", "I", "D"]
    out = {name: np.zeros(n) for name in names}

    y, v = 0.0, 0.0                          # système au repos
    integral = 0.0
    y_meas_prev = sensor(y, p["sigma_meas"], rng)

    for k in range(n):
        y_meas = sensor(y, p["sigma_meas"], rng)
        e = tracking_error(r[k], y_meas)
        u, u_raw, P, I, D, integral = pid_step(e, y_meas, y_meas_prev, integral, p, dt)

        for name, value in zip(names, [y, y_meas, e, u, u_raw, P, I, D]):
            out[name][k] = value

        y, v = plant_step(y, v, u, d[k], p, dt)
        y_meas_prev = y_meas

    out.update({"t": t, "r": r, "d": d, "u_max": p["u_max"], "t_pert": p["t_pert"]})
    return out
`;

  function windowBefore(result) {
    const end = result.t.findIndex((time) => time >= result.t_pert);
    return end <= 0 ? result.t.length : end;
  }

  function overshootPercent(result) {
    const target = result.r[0];
    if (!target) return NaN;
    const span = result.y.slice(0, windowBefore(result));
    const peak = target > 0 ? Math.max.apply(null, span) : Math.min.apply(null, span);
    return Math.max(0, ((peak - target) / target) * 100);
  }

  function settlingTime(result) {
    const target = result.r[0];
    const tolerance = 0.02 * Math.abs(target);
    const end = windowBefore(result);
    let lastOutside = -1;
    for (let index = 0; index < end; index += 1) {
      if (Math.abs(result.y[index] - target) > tolerance) lastOutside = index;
    }
    if (lastOutside >= end - 1) return NaN;
    return result.t[lastOutside + 1];
  }

  function staticError(result) {
    const count = Math.max(1, Math.floor(result.e.length * 0.05));
    const tail = result.e.slice(-count).map((value, index) => result.r[result.r.length - count + index] - result.y[result.y.length - count + index]);
    return tail.reduce((sum, value) => sum + value, 0) / count;
  }

  const DESCRIPTION = [
    '<p>Une masse reliée à un ressort et à un amortisseur doit atteindre une <strong>position de consigne</strong>. ',
    'Un correcteur <strong>PID</strong> calcule la force à appliquer à partir de l\'écart mesuré, avec une commande limitée à ±u_max.</p>',
    '<p class="equation-inline">m ÿ + c ẏ + k y = u + d(t)<br>u = sat(Kp e + Ki ∫e dt − Kd dy/dt)</p>',
    '<p>Essayez : Ki = 0 (erreur statique due au ressort), Kd = 0 (oscillations), u_max faible sans anti-windup (gros dépassement), bruit capteur non nul (terme D bruité).</p>'
  ].join('');

  App.registerSystem({
    id: 'pid',
    name: 'Régulateur PID',
    subtitle: 'Asservissement de position d\'un système masse-ressort-amortisseur',
    description: DESCRIPTION,
    timeKey: 't',
    code: CODE,
    params: [
      { id: 'Kp', label: 'Gain proportionnel', symbol: 'Kp', unit: 'N/m', min: 0, max: 100, step: 0.5, default: 20, group: 'Correcteur PID', block: 'pid' },
      { id: 'Ki', label: 'Gain intégral', symbol: 'Ki', unit: 'N/(m·s)', min: 0, max: 100, step: 0.5, default: 15, group: 'Correcteur PID', block: 'pid' },
      { id: 'Kd', label: 'Gain dérivé', symbol: 'Kd', unit: 'N·s/m', min: 0, max: 20, step: 0.1, default: 4, group: 'Correcteur PID', block: 'pid' },
      { id: 'u_max', label: 'Saturation de la commande', symbol: 'u_max', unit: 'N', min: 0.5, max: 100, step: 0.5, default: 10, group: 'Correcteur PID', block: 'pid' },
      { id: 'antiwindup', label: 'Anti-windup (0 = non, 1 = oui)', symbol: 'AW', unit: '', min: 0, max: 1, step: 1, default: 1, group: 'Correcteur PID', block: 'pid' },
      { id: 'setpoint', label: 'Consigne', symbol: 'r₀', unit: 'm', min: -5, max: 5, step: 0.1, default: 1, group: 'Consigne et perturbation', block: 'setpoint' },
      { id: 't_pert', label: 'Instant de la perturbation', symbol: 't_pert', unit: 's', min: 0, max: 30, step: 0.1, default: 6, group: 'Consigne et perturbation', block: 'plant', advanced: true },
      { id: 'd_amp', label: 'Amplitude de la perturbation', symbol: 'd', unit: 'N', min: -20, max: 20, step: 0.5, default: -5, group: 'Consigne et perturbation', block: 'plant' },
      { id: 'm', label: 'Masse', symbol: 'm', unit: 'kg', min: 0.1, max: 10, step: 0.1, default: 1, group: 'Système', block: 'plant' },
      { id: 'c', label: 'Amortissement', symbol: 'c', unit: 'N·s/m', min: 0, max: 10, step: 0.1, default: 0.5, group: 'Système', block: 'plant' },
      { id: 'k', label: 'Raideur du ressort', symbol: 'k', unit: 'N/m', min: 0, max: 20, step: 0.1, default: 2, group: 'Système', block: 'plant' },
      { id: 'sigma_meas', label: 'Bruit du capteur', symbol: 'σ', unit: 'm', min: 0, max: 0.1, step: 0.001, default: 0, group: 'Système', block: 'sensor' },
      { id: 'dt', label: 'Pas de temps', symbol: 'dt', unit: 's', min: 0.001, max: 0.05, step: 0.001, default: 0.01, group: 'Simulation', block: 'plant', advanced: true },
      { id: 'N', label: 'Nombre de pas', symbol: 'N', unit: '', min: 100, max: 3000, step: 10, default: 1500, group: 'Simulation', block: 'plant', advanced: true }
    ],
    diagram: {
      width: 1200,
      cycle: ['setpoint', 'error', 'pid', 'plant', 'sensor'],
      zones: [
        { label: 'CORRECTEUR', blocks: ['setpoint', 'error', 'pid'] },
        { label: 'PROCÉDÉ', blocks: ['plant', 'sensor'] }
      ],
      blocks: [
        {
          id: 'setpoint', title: 'Consigne', kind: 'io', x: 28, row: 0, w: 168, h: 96,
          lines: ['r(t) = r₀'],
          readouts: [{ label: 'r', key: 'r', format: 3 }],
          info: '<p>La position que l\'on souhaite atteindre : un échelon d\'amplitude r₀ dès t = 0.</p>'
        },
        {
          id: 'error', title: 'Comparateur', kind: 'measure', x: 280, row: 0, w: 170, h: 96,
          lines: ['e = r − yₘ'],
          readouts: [{ label: 'e', key: 'e', format: 3 }],
          info: '<p>Le correcteur ne connaît pas la vraie position : il compare la consigne à la <strong>mesure</strong>.</p>'
        },
        {
          id: 'pid', title: 'Correcteur PID', kind: 'estimate', x: 536, row: 0, w: 276, h: 200,
          lines: ['P = Kp e', 'I = Ki Σ e dt', 'D = −Kd Δyₘ/dt', 'u = sat(P + I + D)'],
          readouts: [{ label: 'u', key: 'u', format: 3 }, { label: 'I', key: 'I', format: 3 }],
          info: '<p><strong>P</strong> réagit à l\'erreur présente, <strong>I</strong> accumule l\'erreur passée et supprime l\'erreur statique, <strong>D</strong> freine la variation de la mesure et amortit.</p><p>La commande est saturée à ±u_max. Sans anti-windup, l\'intégrale continue de croître pendant la saturation : c\'est l\'emballement intégral (« windup »).</p>'
        },
        {
          id: 'plant', title: 'Masse-ressort', kind: 'process', x: 900, row: 0, w: 276, h: 200,
          lines: ['m ÿ + c ẏ + k y', '    = u + d(t)'],
          readouts: [{ label: 'y', key: 'y', format: 3 }, { label: 'd', key: 'd', format: 2 }],
          info: '<p>Le système à commander. Le ressort tire la masse vers 0 : un correcteur P seul laisse donc une erreur statique. La perturbation d(t) est une force extérieure en échelon.</p>'
        },
        {
          id: 'sensor', title: 'Capteur', kind: 'measure', x: 920, row: 1, w: 236, h: 84,
          lines: ['yₘ = y + bruit'],
          readouts: [{ label: 'yₘ', key: 'y_meas', format: 3 }],
          info: '<p>Mesure de la position, éventuellement bruitée. Le bruit est amplifié par le terme dérivé, qui divise par dt.</p>'
        }
      ],
      edges: [
        { from: 'setpoint', to: 'error', label: 'r', readout: { key: 'r', format: 3 } },
        { from: 'error', to: 'pid', label: 'e', readout: { key: 'e', format: 3 } },
        { from: 'pid', to: 'plant', label: 'u', readout: { key: 'u', format: 3 } },
        { from: 'plant', to: 'sensor', label: 'y', fromSide: 'bottom', toSide: 'top', readout: { key: 'y', format: 3 } },
        { from: 'sensor', to: 'error', label: 'yₘ', fromSide: 'left', toSide: 'bottom', loop: true, readout: { key: 'y_meas', format: 3 } }
      ]
    },
    plots: [
      {
        id: 'output', title: 'Sortie et consigne', xKey: 't', yLabel: 'position (m)',
        traces: [
          { key: 'r', name: 'Consigne r', kind: 'step', color: 'truth', width: 1.5 },
          { key: 'y', name: 'Sortie y', kind: 'line', color: 'series-1' }
        ]
      },
      {
        id: 'command', title: 'Commande u (lignes : ±u_max)', xKey: 't', yLabel: 'force (N)',
        hlines: [{ value: 'u_max' }, { value: 'u_max', scale: -1 }],
        traces: [
          { key: 'u_raw', name: 'Avant saturation', kind: 'line', color: 'muted', width: 1.5 },
          { key: 'u', name: 'Commande u', kind: 'line', color: 'series-1' }
        ]
      },
      {
        id: 'error', title: 'Erreur e = r − yₘ', xKey: 't', yLabel: 'e (m)',
        traces: [{ key: 'e', name: 'Erreur e', kind: 'line', color: 'series-1' }]
      },
      {
        id: 'terms', title: 'Termes P, I, D', xKey: 't', yLabel: 'force (N)',
        traces: [
          { key: 'P', name: 'P', kind: 'line', color: 'series-1' },
          { key: 'I', name: 'I', kind: 'line', color: 'series-2' },
          { key: 'D', name: 'D', kind: 'line', color: 'series-3' }
        ]
      }
    ],
    readouts: [
      { label: 'Dépassement', unit: '%', format: 1, compute: overshootPercent, hint: 'Dépassement maximal de la consigne, avant la perturbation.' },
      { label: 'Temps de réponse à 2 %', unit: 's', format: 2, compute: settlingTime, hint: 'Instant à partir duquel y reste à ±2 % de la consigne (avant la perturbation).' },
      { label: 'Erreur statique', unit: 'm', format: 4, compute: staticError, hint: 'Écart moyen r − y sur les 5 % derniers instants.' },
      { label: 'Commande max', unit: 'N', format: 2, compute: (r) => Math.max.apply(null, r.u.map(Math.abs)), hint: 'Valeur absolue maximale de la commande appliquée.' }
    ]
  });
})(window.App = window.App || {});
