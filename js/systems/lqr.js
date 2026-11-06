(function (App) {
  const CODE = String.raw`# =====================================================================
#  Régulateur LQR discret : asservissement de position
#  d'un système masse-ressort-amortisseur
# =====================================================================
#
#  Contrat avec la page : simulate(p) -> dict de listes / tableaux.
#  Les marqueurs « # >>> block: ... » relient le code aux blocs du schéma.
#
#  Deux temps bien distincts :
#    1. HORS LIGNE : on calcule une fois pour toutes le gain K en
#       résolvant l'équation de Riccati (bloc « Riccati → K »).
#    2. EN LIGNE, à chaque pas k :
#       consigne x_ref -> commande u = −K (x − x_ref) + u_ff
#       -> système (état x = [y, ẏ]) -> état mesuré -> retour
#
#  Une perturbation d(t) (force extérieure) s'ajoute à u sur la masse.
#  Le régulateur ne la mesure pas : il ne la « voit » qu'à travers x.
# =====================================================================

import numpy as np


# >>> block: disturbance
# ---------------------------------------------------------------------
#  Perturbation : une force extérieure en échelon
# ---------------------------------------------------------------------
#      d(t) = d · 1(t ≥ t_pert)
#
#  Nulle avant t_pert, égale à d ensuite (pensez à un poids posé sur la
#  masse). Le régulateur ne la mesure pas et ne la connaît pas : elle
#  n'apparaît pas dans le calcul de K.
#
#  Le retour d'état u = −K (x − x_ref) + u_ff n'a pas de mémoire (pas
#  d'action intégrale). À l'équilibre, ẏ = 0 et le bilan des forces
#  donne k·y = u + d, avec u = −K₀ (y − r) + k·r. On en tire l'erreur
#  statique qui subsiste :
#      Δy = y − r = d / (k + K₀)
#  Plus K₀ est grand (q_pos grand, R petit), plus l'écart est faible,
#  mais il ne s'annule jamais.

def disturbance(t, p):
    return np.where(t >= p["t_pert"], p["d_amp"], 0.0)
# <<< block: disturbance


# >>> block: plant
# ---------------------------------------------------------------------
#  Système commandé : masse-ressort-amortisseur
# ---------------------------------------------------------------------
#      m·ÿ + c·ẏ + k·y = u + d(t)
#
#  Représentation d'état, avec x = [y, ẏ] (position, vitesse) :
#      ẋ = A x + B (u + d)
#      A = [[0, 1], [−k/m, −c/m]]      B = [0, 1/m]
#
#  Discrétisation EXACTE (bloqueur d'ordre zéro : u constant sur dt) :
#      x[k+1] = A_d x[k] + B_d (u[k] + d[k])
#      A_d = exp(A·dt)                 B_d = ∫₀^dt exp(A·s) ds · B
#
#  Astuce classique : les deux s'obtiennent d'un coup avec l'exponentielle
#  de la matrice augmentée M = [[A, B], [0, 0]] :
#      exp(M·dt) = [[A_d, B_d], [0, 1]]
#
#  L'exponentielle est calculée sans scipy : série de Taylor tronquée,
#  précédée d'une mise à l'échelle (on divise M·dt par 2^s pour que la
#  série converge vite) puis de s élévations au carré.

def continuous_model(p):
    A = np.array([[0.0, 1.0],
                  [-p["k"] / p["m"], -p["c"] / p["m"]]])
    B = np.array([[0.0],
                  [1.0 / p["m"]]])
    return A, B


def expm(M, terms=12):
    norm = np.max(np.sum(np.abs(M), axis=1))
    s = max(0, int(np.ceil(np.log2(norm / 0.5)))) if norm > 0.5 else 0
    X = M / 2.0 ** s
    result = np.eye(len(M))
    term = np.eye(len(M))
    for n in range(1, terms + 1):
        term = term @ X / n                  # Xⁿ / n!
        result = result + term
    for _ in range(s):
        result = result @ result             # exp(X)^(2^s) = exp(M)
    return result


def discretize(A, B, dt):
    n, m = B.shape
    M = np.zeros((n + m, n + m))
    M[:n, :n] = A
    M[:n, n:] = B
    E = expm(M * dt)
    return E[:n, :n], E[:n, n:]              # A_d, B_d


def plant_step(x, u, d, Ad, Bd):
    return Ad @ x + Bd[:, 0] * (u + d)
# <<< block: plant


# >>> block: riccati
# ---------------------------------------------------------------------
#  Conception hors ligne : équation de Riccati -> gain K
# ---------------------------------------------------------------------
#  On cherche la commande qui minimise le coût
#      J = Σ ( xᵀ Q x + uᵀ R u )
#  Q pénalise l'écart d'état (performance), R pénalise l'effort (énergie).
#  Seul le RAPPORT entre Q et R compte : multiplier Q et R par 10 donne
#  le même gain K.
#
#  La solution optimale est un retour d'état linéaire u = −K x, avec
#      K = (R + B_dᵀ P B_d)⁻¹ B_dᵀ P A_d
#  où P est la solution de l'équation de Riccati algébrique discrète :
#      P = Q + A_dᵀ P A_d − A_dᵀ P B_d (R + B_dᵀ P B_d)⁻¹ B_dᵀ P A_d
#
#  On la résout par itération à point fixe : on part de P = Q et on
#  applique la formule jusqu'à ce que P ne bouge plus. Chaque itération
#  revient à allonger d'un pas l'horizon de l'optimisation (programmation
#  dynamique à rebours) : P tend vers le coût d'un horizon infini.

def weights(p):
    Q = np.diag([p["q_pos"], p["q_vel"]])
    R = np.array([[p["r_weight"]]])
    return Q, R


RICCATI_TOL = 1e-10
RICCATI_MAX_ITER = 20000


def solve_riccati(Ad, Bd, Q, R, tol=RICCATI_TOL, max_iter=RICCATI_MAX_ITER):
    P = Q.copy()
    for iteration in range(1, max_iter + 1):
        S = R + Bd.T @ P @ Bd                            # scalaire 1×1 ici
        gain = np.linalg.solve(S, Bd.T @ P @ Ad)         # (R + BᵀPB)⁻¹ BᵀPA
        P_next = Q + Ad.T @ P @ Ad - Ad.T @ P @ Bd @ gain
        P_next = 0.5 * (P_next + P_next.T)               # garde P symétrique
        change = np.max(np.abs(P_next - P)) / max(1.0, np.max(np.abs(P_next)))
        P = P_next
        if change < tol:
            break
    K = np.linalg.solve(R + Bd.T @ P @ Bd, Bd.T @ P @ Ad)
    return K, P, iteration


def closed_loop_poles(Ad, Bd, K):
    # Valeurs propres de A_d − B_d K : la boucle est stable si toutes ont
    # un module < 1 (cercle unité, puisque le modèle est discret).
    return np.linalg.eigvals(Ad - Bd @ K)
# <<< block: riccati


# >>> block: reference
# ---------------------------------------------------------------------
#  Consigne : état visé et commande d'équilibre
# ---------------------------------------------------------------------
#  On veut la masse immobile en y = r : x_ref = [r, 0].
#  À l'équilibre, le ressort tire avec la force k·r : il faut la
#  compenser en permanence. C'est la commande d'anticipation u_ff = k·r.
#  Sans elle, le retour d'état laisserait une erreur statique.

def reference(r, k_spring):
    x_ref = np.array([r, 0.0])
    u_ff = k_spring * r
    return x_ref, u_ff
# <<< block: reference


# >>> block: controller
# ---------------------------------------------------------------------
#  Commande par retour d'état, avec saturation
# ---------------------------------------------------------------------
#      u = −K (x − x_ref) + u_ff        puis   u = sat(u, ±u_max)
#
#  K agit sur l'écart d'état : K₀ joue le rôle d'un gain proportionnel,
#  K₁ celui d'un gain dérivé (il freine la vitesse). Mais ici ces gains
#  sont CALCULÉS par Riccati, pas réglés à la main.
#
#  La saturation sort du cadre linéaire du LQR : la garantie
#  d'optimalité (et de stabilité) ne tient plus quand u est écrêté.

def control(x, x_ref, u_ff, K, u_max):
    u_unsat = float(-(K @ (x - x_ref))[0] + u_ff)
    u = float(np.clip(u_unsat, -u_max, u_max))
    return u, u_unsat
# <<< block: controller


# >>> block: state
# ---------------------------------------------------------------------
#  État mesuré : hypothèse du LQR
# ---------------------------------------------------------------------
#  Le LQR suppose l'état COMPLET connu : position ET vitesse.
#  En pratique, on ne mesure souvent que la position : un filtre de
#  Kalman reconstruit alors x̂ = [ŷ, ŷ'] et on applique u = −K x̂.
#  Kalman + LQR : c'est la commande LQG.

def measure_state(x):
    return x.copy()
# <<< block: state


def stage_cost(x_err, u_err, Q, R):
    # Coût instantané en écart à l'équilibre : δxᵀ Q δx + δuᵀ R δu
    return float(x_err @ Q @ x_err + R[0, 0] * u_err ** 2)


def simulate(p):
    dt = float(p["dt"])
    n = int(p["N"])
    t = np.arange(n) * dt

    # --- Conception hors ligne (une seule fois) ---
    A, B = continuous_model(p)
    Ad, Bd = discretize(A, B, dt)
    Q, R = weights(p)
    K, P, iterations = solve_riccati(Ad, Bd, Q, R)
    poles = closed_loop_poles(Ad, Bd, K)

    print("A_d =", np.round(Ad, 6).tolist())
    print("B_d =", np.round(Bd[:, 0], 8).tolist())
    print("K   =", np.round(K[0], 4).tolist(), "après", iterations, "itérations")
    if iterations >= RICCATI_MAX_ITER:
        print("Attention : Riccati n'a pas convergé, K est approché.")
    print("|pôles de A_d − B_d K| =", np.round(np.abs(poles), 6).tolist())

    # --- Boucle fermée ---
    r = np.full(n, float(p["r0"]))
    d_t = disturbance(t, p)                  # perturbation à chaque pas
    names = ["y", "v", "u", "u_unsat", "u_ff", "cost_inst", "x_err"]
    out = {name: np.zeros(n) for name in names}

    x = np.array([float(p["y0"]), float(p["v0"])])
    for k in range(n):
        x_ref, u_ff = reference(r[k], p["k"])
        x_meas = measure_state(x)
        u, u_unsat = control(x_meas, x_ref, u_ff, K, p["u_max"])
        cost = stage_cost(x_meas - x_ref, u - u_ff, Q, R)

        for name, value in zip(names, [x[0], x[1], u, u_unsat, u_ff, cost, x[0] - r[k]]):
            out[name][k] = value

        x = plant_step(x, u, d_t[k], Ad, Bd)

    out.update({
        "t": t, "r": r, "d_t": d_t,
        "cost_cum": np.cumsum(out["cost_inst"]),
        "K0": float(K[0, 0]), "K1": float(K[0, 1]),
        "iterations": iterations,
        "eig_abs_max": float(np.max(np.abs(poles))),
        "u_max": p["u_max"], "t_pert": p["t_pert"],
    })
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

  function last(series) {
    return series[series.length - 1];
  }

  const DESCRIPTION = [
    '<p>La même masse-ressort-amortisseur que pour le PID, commandée cette fois par un <strong>régulateur LQR</strong> (linéaire quadratique). ',
    'On choisit des <strong>pondérations</strong> : Q pénalise l\'écart d\'état (performance), R pénalise la commande (effort). ',
    'Le gain K qui minimise le coût J est ensuite <strong>calculé</strong> hors ligne par l\'équation de Riccati, et non réglé à la main comme Kp, Ki, Kd.</p>',
    '<p class="equation-inline">x = [y, ẏ] · x[k+1] = A_d x[k] + B_d u[k]<br>',
    'J = Σ (xᵀ Q x + uᵀ R u) · u = −K (x − x_ref) + k r</p>',
    '<p>Sans saturation, la boucle fermée est <strong>garantie stable</strong> : les pôles de A_d − B_d K sont dans le cercle unité. ',
    'Le LQR suppose l\'état complet connu. Quand on ne mesure que la position, un <strong>filtre de Kalman</strong> fournit cet état : Kalman + LQR forment la commande <strong>LQG</strong>. ',
    'Les deux problèmes sont duaux : même équation de Riccati, (A, B, Q, R) d\'un côté, (Fᵀ, Hᵀ, Q, R) de l\'autre.</p>',
    '<p>À t = t_pert, une <strong>perturbation</strong> d (force extérieure en échelon) s\'applique sur la masse : la sortie s\'écarte de la consigne et y reste, avec une erreur statique Δy = d / (k + K₀). Le trait pointillé des graphes marque cet instant.</p>',
    '<p>Essayez : R très grand (commande douce et lente), q_pos très grand (réponse rapide, mais la commande sature), une perturbation d (l\'erreur statique ne s\'annule pas : il n\'y a pas d\'action intégrale). ',
    'Question ouverte : comment ajouter une action intégrale au LQR ?</p>'
  ].join('');

  const REFERENCES = [
    {
      authors: 'R. E. Kalman',
      year: 1960,
      title: 'Contributions to the Theory of Optimal Control',
      where: 'Boletín de la Sociedad Matemática Mexicana, vol. 5, p. 102–119',
      note: 'Article fondateur du régulateur linéaire quadratique et de l\'équation de Riccati associée.'
    },
    {
      authors: 'B. D. O. Anderson, J. B. Moore',
      year: 1990,
      title: 'Optimal Control: Linear Quadratic Methods',
      where: 'Prentice Hall ; réédition Dover, 2007 (ISBN 978-0-486-45766-6)',
      note: 'Traité de référence du LQR, en temps continu et discret.'
    },
    {
      authors: 'K. J. Åström, R. M. Murray',
      year: 2021,
      title: 'Feedback Systems: An Introduction for Scientists and Engineers, 2e édition',
      where: 'Princeton University Press, section 7.5 « Linear Quadratic Regulators »',
      url: 'https://fbsbook.org',
      note: 'Livre libre en ligne. La section 7.4 « Integral Action » répond à la question ouverte sur l\'erreur statique.'
    }
  ];

  App.registerSystem({
    id: 'lqr',
    name: 'Régulateur LQR',
    subtitle: 'Commande optimale par retour d\'état d\'un système masse-ressort-amortisseur',
    description: DESCRIPTION,
    references: REFERENCES,
    timeKey: 't',
    code: CODE,
    params: [
      { id: 'q_pos', label: 'Poids de la position', symbol: 'q_pos', unit: '', min: 0.01, max: 1000, step: 0.01, default: 10, group: 'Pondérations', block: 'riccati', log: true },
      { id: 'q_vel', label: 'Poids de la vitesse', symbol: 'q_vel', unit: '', min: 0.01, max: 1000, step: 0.01, default: 1, group: 'Pondérations', block: 'riccati', log: true },
      { id: 'r_weight', label: 'Poids de la commande', symbol: 'R', unit: '', min: 0.001, max: 100, step: 0.001, default: 0.1, group: 'Pondérations', block: 'riccati', log: true },
      { id: 'u_max', label: 'Saturation de la commande', symbol: 'u_max', unit: 'N', min: 0.5, max: 100, step: 0.5, default: 10, group: 'Commande', block: 'controller' },
      { id: 'r0', label: 'Consigne', symbol: 'r₀', unit: 'm', min: -5, max: 5, step: 0.1, default: 1, group: 'Consigne et perturbation', block: 'reference' },
      { id: 't_pert', label: 'Instant de la perturbation', symbol: 't_pert', unit: 's', min: 0, max: 30, step: 0.1, default: 6, group: 'Consigne et perturbation', block: 'disturbance' },
      { id: 'd_amp', label: 'Amplitude de la perturbation', symbol: 'd', unit: 'N', min: -20, max: 20, step: 0.5, default: -5, group: 'Consigne et perturbation', block: 'disturbance' },
      { id: 'm', label: 'Masse', symbol: 'm', unit: 'kg', min: 0.1, max: 10, step: 0.1, default: 1, group: 'Système', block: 'plant' },
      { id: 'c', label: 'Amortissement', symbol: 'c', unit: 'N·s/m', min: 0, max: 10, step: 0.1, default: 0.5, group: 'Système', block: 'plant' },
      { id: 'k', label: 'Raideur du ressort', symbol: 'k', unit: 'N/m', min: 0, max: 20, step: 0.1, default: 2, group: 'Système', block: 'plant' },
      { id: 'dt', label: 'Pas de temps', symbol: 'dt', unit: 's', min: 0.001, max: 0.05, step: 0.001, default: 0.01, group: 'Simulation', block: 'plant', advanced: true },
      { id: 'N', label: 'Nombre de pas', symbol: 'N', unit: '', min: 100, max: 3000, step: 10, default: 1500, group: 'Simulation', block: 'plant', advanced: true },
      { id: 'y0', label: 'Position initiale', symbol: 'y₀', unit: 'm', min: -5, max: 5, step: 0.1, default: 0, group: 'Simulation', block: 'plant', advanced: true },
      { id: 'v0', label: 'Vitesse initiale', symbol: 'ẏ₀', unit: 'm/s', min: -5, max: 5, step: 0.1, default: 0, group: 'Simulation', block: 'plant', advanced: true }
    ],
    diagram: {
      width: 1200,
      cycle: ['reference', 'controller', 'plant', 'state'],
      zones: [
        { label: 'CONCEPTION (HORS LIGNE)', blocks: ['riccati'] },
        { label: 'BOUCLE FERMÉE', blocks: ['reference', 'controller', 'plant', 'state'] }
      ],
      blocks: [
        {
          id: 'riccati', title: 'Riccati → K', kind: 'estimate', x: 230, row: 0, w: 400, h: 200,
          lines: ['J = Σ xᵀQx + uᵀRu', 'P = Q + AᵀPA − AᵀPB (R + BᵀPB)⁻¹ BᵀPA', 'K = (R + BᵀPB)⁻¹ BᵀPA'],
          readouts: [
            { label: 'K₀', key: 'K0', format: 3 },
            { label: 'K₁', key: 'K1', format: 3 },
            { label: 'itérations', key: 'iterations', format: 'int' }
          ],
          info: '<p>Calcul <strong>hors ligne</strong>, une seule fois avant la simulation. Les matrices sont discrètes : A = A_d, B = B_d (affichées dans la console Python).</p><p>Q = diag(q_pos, q_vel) pénalise l\'écart d\'état, R pénalise la commande. Seul le <strong>rapport</strong> Q / R compte. On itère l\'équation de Riccati à partir de P = Q jusqu\'à ce que P ne bouge plus, puis on en déduit le gain K.</p>'
        },
        {
          id: 'disturbance', title: 'Perturbation', kind: 'io', x: 674, row: 0, w: 216, h: 120,
          lines: ['d(t) = d · 1(t ≥ t_pert)'],
          readouts: [{ label: 'd', key: 'd_t', format: 2 }],
          info: '<p>Une <strong>force extérieure</strong> en échelon, nulle avant t_pert et égale à d ensuite. Le régulateur ne la mesure pas : il ne la voit qu\'à travers l\'état x.</p><p>Sans action intégrale, le LQR ne l\'annule pas : une <strong>erreur statique</strong> Δy = d / (k + K₀) subsiste. Un PID l\'annule grâce à son terme intégral.</p>'
        },
        {
          id: 'reference', title: 'Consigne', kind: 'io', x: 28, row: 1, w: 190, h: 150,
          lines: ['x_ref = [r, 0]', 'u_ff = k r'],
          readouts: [{ label: 'r', key: 'r', format: 3 }, { label: 'u_ff', key: 'u_ff', format: 3 }],
          info: '<p>L\'état visé : la masse immobile en y = r. À l\'équilibre, le ressort tire avec la force k r. La commande d\'anticipation <code>u_ff = k r</code> la compense, sinon une erreur statique subsiste.</p>'
        },
        {
          id: 'controller', title: 'Retour d\'état', kind: 'estimate', x: 300, row: 1, w: 260, h: 150,
          lines: ['u = −K (x − x_ref) + u_ff', 'u = sat(u, ±u_max)'],
          readouts: [{ label: 'u', key: 'u', format: 3 }, { label: 'avant sat', key: 'u_unsat', format: 3 }],
          info: '<p>K₀ agit comme un gain proportionnel sur la position, K₁ comme un gain dérivé sur la vitesse. Ces gains sont <strong>calculés</strong> par Riccati.</p><p>La saturation sort du cadre linéaire : quand u est écrêté, la garantie d\'optimalité et de stabilité du LQR ne tient plus.</p>'
        },
        {
          id: 'plant', title: 'Masse-ressort', kind: 'process', x: 644, row: 1, w: 276, h: 150,
          lines: ['m ÿ + c ẏ + k y = u + d(t)', 'x[k+1] = A_d x + B_d (u + d)'],
          readouts: [{ label: 'y', key: 'y', format: 3 }, { label: 'ẏ', key: 'v', format: 3 }],
          info: '<p>Le système à commander, identique à celui du PID. Avec x = [y, ẏ] : A = [[0, 1], [−k/m, −c/m]], B = [0, 1/m].</p><p>La discrétisation est <strong>exacte</strong> (commande constante sur dt) : A_d = exp(A dt), calculée par série de Taylor. La perturbation d(t) s\'ajoute à u. L\'état initial se règle dans « Paramètres de simulation ».</p>'
        },
        {
          id: 'state', title: 'État mesuré', kind: 'measure', x: 1000, row: 1, w: 176, h: 150,
          lines: ['x = [y, ẏ]'],
          readouts: [{ label: 'y − r', key: 'x_err', format: 3 }],
          info: '<p>Le LQR suppose l\'état <strong>complet</strong> connu : position et vitesse. Si l\'on ne mesure que la position, un filtre de Kalman estime x̂ et l\'on applique u = −K x̂ : c\'est la commande LQG.</p>'
        }
      ],
      edges: [
        { from: 'riccati', to: 'controller', label: 'K', fromSide: 'bottom', toSide: 'top', readout: { key: 'K0', format: 3 } },
        { from: 'reference', to: 'controller', label: 'x_ref', readout: { key: 'r', format: 3 } },
        { from: 'controller', to: 'plant', label: 'u', readout: { key: 'u', format: 3 } },
        { from: 'disturbance', to: 'plant', label: 'd', fromSide: 'bottom', toSide: 'top', readout: { key: 'd_t', format: 2 } },
        { from: 'plant', to: 'state', label: 'x' },
        { from: 'state', to: 'controller', label: 'x', fromSide: 'bottom', toSide: 'bottom', loop: true, readout: { key: 'y', format: 3 } }
      ]
    },
    plots: [
      {
        id: 'output', title: 'Sortie et consigne', xKey: 't', yLabel: 'position (m)',
        vlines: [{ key: 't_pert', label: 'perturbation' }],
        traces: [
          { key: 'r', name: 'Consigne r', kind: 'step', color: 'truth', width: 1.5 },
          { key: 'y', name: 'Sortie y', kind: 'line', color: 'series-1' }
        ]
      },
      {
        id: 'velocity', title: 'Vitesse', xKey: 't', yLabel: 'ẏ (m/s)',
        traces: [{ key: 'v', name: 'Vitesse ẏ', kind: 'line', color: 'series-1' }]
      },
      {
        id: 'command', title: 'Commande u et perturbation d (lignes : ±u_max)', xKey: 't', yLabel: 'force (N)',
        hlines: [{ value: 'u_max' }, { value: 'u_max', scale: -1 }],
        vlines: [{ key: 't_pert', label: 'perturbation' }],
        traces: [
          { key: 'u_unsat', name: 'Avant saturation', kind: 'line', color: 'muted', width: 1.5 },
          { key: 'u', name: 'Commande u', kind: 'line', color: 'series-1' },
          { key: 'd_t', name: 'Perturbation d', kind: 'step', color: 'muted', width: 1.5, dash: 'dash' }
        ]
      },
      {
        id: 'cost', title: 'Coût cumulé J(t)', xKey: 't', yLabel: 'J',
        traces: [{ key: 'cost_cum', name: 'J(t) = Σ δxᵀQδx + R δu²', kind: 'line', color: 'series-2' }]
      }
    ],
    readouts: [
      { label: 'K₀', unit: 'N/m', format: 3, compute: (r) => r.K0, hint: 'Gain sur l\'écart de position.' },
      { label: 'K₁', unit: 'N·s/m', format: 3, compute: (r) => r.K1, hint: 'Gain sur la vitesse.' },
      { label: 'Dépassement', unit: '%', format: 1, compute: overshootPercent, hint: 'Dépassement maximal de la consigne, avant la perturbation.' },
      { label: 'Temps de réponse à 2 %', unit: 's', format: 2, compute: settlingTime, hint: 'Instant à partir duquel y reste à ±2 % de la consigne (avant la perturbation).' },
      { label: 'Coût total J', unit: '', compute: (r) => last(r.cost_cum), hint: 'Somme des coûts instantanés sur toute la simulation.' },
      { label: 'Module max des pôles', unit: '', format: 5, compute: (r) => r.eig_abs_max, hint: '< 1 = stable' }
    ]
  });
})(window.App = window.App || {});
