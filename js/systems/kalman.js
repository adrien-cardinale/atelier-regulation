(function (App) {
  const CODE = String.raw`# =====================================================================
#  Filtre de Kalman : suivi 1D d'un mobile (position, vitesse)
# =====================================================================
#
#  Ce code est exécuté dans votre navigateur (Pyodide) à chaque
#  modification. Contrat avec la page :
#
#      simulate(p) -> dict
#
#  - p contient les valeurs des curseurs (p["dt"], p["sigma_a"], ...) ;
#  - le dict retourné contient des listes ou des tableaux numpy, que la
#    page trace (clés t, x_true, z, x_est, P00, K0, ...).
#
#  Les marqueurs « # >>> block: ... » et « # <<< block: ... » relient
#  chaque région du code à un bloc du schéma : cliquez un bloc pour
#  retrouver son code, ou placez le curseur dans une région.
#
#  Astuce : print(...) écrit dans la console sous l'éditeur.
# =====================================================================

import numpy as np


# >>> block: truth
# ---------------------------------------------------------------------
#  Système réel (la « vérité terrain », inconnue du filtre)
# ---------------------------------------------------------------------
#  État x = [position, vitesse]. Entre deux instants séparés de dt :
#
#      x_k = F x_{k-1} + G a_{k-1}
#
#  où a est l'accélération réelle du mobile. Elle comporte une partie
#  régulière (sinusoïde) et une partie aléatoire (bruit de processus).
#  Le filtre, lui, suppose seulement « vitesse constante + bruit ».

def transition_matrix(dt):
    """Matrice F du modèle à vitesse constante."""
    return np.array([[1.0, dt],
                     [0.0, 1.0]])


def simulate_truth(p, t, rng):
    """Trajectoire réelle : retourne un tableau (N, 2) de [position, vitesse]."""
    dt = p["dt"]
    F = transition_matrix(dt)
    G = np.array([0.5 * dt**2, dt])          # effet d'une accélération sur [x, v]

    accel = p["a_amp"] * np.sin(2.0 * np.pi * t / p["a_period"])
    accel = accel + p["sigma_a_true"] * rng.standard_normal(len(t))

    states = np.zeros((len(t), 2))           # départ : x = 0 m, v = 0 m/s
    for k in range(1, len(t)):
        states[k] = F @ states[k - 1] + G * accel[k - 1]
    return states
# <<< block: truth


# >>> block: measure
# ---------------------------------------------------------------------
#  Capteur : on ne mesure que la position, avec du bruit
# ---------------------------------------------------------------------
#      z_k = H x_k + v_k        avec  v_k ~ N(0, sigma_z_true²)

H = np.array([[1.0, 0.0]])                   # on observe la position seule


def measure(states, sigma_z_true, rng):
    """Mesures bruitées de la position."""
    noise = sigma_z_true * rng.standard_normal(len(states))
    return states @ H[0] + noise
# <<< block: measure


# >>> block: predict
# ---------------------------------------------------------------------
#  Étape 1 du filtre : PRÉDICTION (on avance le modèle d'un pas)
# ---------------------------------------------------------------------
#      x̂⁻ = F x̂                 (l'état estimé suit le modèle)
#      P⁻ = F P Fᵀ + Q          (l'incertitude grandit)
#
#  Q traduit la confiance dans le modèle : le filtre suppose une
#  accélération aléatoire d'écart-type sigma_a (modèle « accélération
#  blanche discrète »). Q grand = « mon modèle est approximatif ».

def process_noise(sigma_a, dt):
    """Covariance Q du bruit de processus supposé par le filtre."""
    return sigma_a**2 * np.array([[dt**4 / 4, dt**3 / 2],
                                  [dt**3 / 2, dt**2]])


def initial_estimate(p, true_start):
    """Estimation initiale volontairement fausse, et sa covariance P0."""
    x_hat = true_start + np.array([p["x0_err"], p["v0_err"]])
    P = p["P0"] * np.eye(2)
    return x_hat, P


def predict(x_hat, P, F, Q):
    x_pred = F @ x_hat
    P_pred = F @ P @ F.T + Q
    return x_pred, P_pred
# <<< block: predict


# >>> block: update
# ---------------------------------------------------------------------
#  Étape 2 du filtre : CORRECTION (on confronte la prédiction à la mesure)
# ---------------------------------------------------------------------
#      y = z − H x̂⁻             innovation : écart mesure / prédiction
#      S = H P⁻ Hᵀ + R          incertitude totale sur cette innovation
#      K = P⁻ Hᵀ S⁻¹            gain de Kalman : part de l'innovation retenue
#      x̂ = x̂⁻ + K y            estimation corrigée
#      P = (I − K H) P⁻         l'incertitude diminue
#
#  R traduit la confiance dans le capteur : R grand => K petit => le
#  filtre lisse beaucoup mais réagit lentement.

def measurement_noise(sigma_z):
    """Covariance R du bruit de mesure supposé par le filtre."""
    return np.array([[sigma_z**2]])


def update(x_pred, P_pred, z, R):
    y = z - H @ x_pred                       # innovation (vecteur de taille 1)
    S = H @ P_pred @ H.T + R                 # matrice 1x1
    K = P_pred @ H.T @ np.linalg.inv(S)      # gain, matrice 2x1
    x_est = x_pred + K @ y
    P_est = (np.eye(2) - K @ H) @ P_pred
    return x_est, P_est, K[:, 0], y[0], S[0, 0]
# <<< block: update


def simulate(p):
    # --- Paramètres de simulation -------------------------------------
    dt = float(p["dt"])
    n = int(p["N"])
    rng = np.random.default_rng(int(p["seed"]))
    t = np.arange(n) * dt

    # --- Monde réel : trajectoire puis mesures -------------------------
    truth = simulate_truth(p, t, rng)
    z = measure(truth, p["sigma_z_true"], rng)

    # --- Hypothèses du filtre (elles peuvent être fausses !) -----------
    F = transition_matrix(dt)
    Q = process_noise(p["sigma_a"], dt)
    R = measurement_noise(p["sigma_z"])
    x_hat, P = initial_estimate(p, truth[0])

    # --- Tableaux de résultats ----------------------------------------
    x_pred = np.zeros(n)
    P_pred00 = np.zeros(n)
    x_est = np.zeros(n)
    v_est = np.zeros(n)
    P00 = np.zeros(n)
    P11 = np.zeros(n)
    K0 = np.zeros(n)
    K1 = np.zeros(n)
    innov = np.zeros(n)
    S = np.zeros(n)

    # --- Boucle du filtre : prédiction puis correction, à chaque pas ---
    for k in range(n):
        if k > 0:                            # à k = 0, la prédiction est l'init
            x_hat, P = predict(x_hat, P, F, Q)
        x_pred[k] = x_hat[0]
        P_pred00[k] = P[0, 0]

        x_hat, P, K, y, s = update(x_hat, P, z[k:k + 1], R)

        x_est[k], v_est[k] = x_hat
        P00[k], P11[k] = P[0, 0], P[1, 1]
        K0[k], K1[k] = K
        innov[k], S[k] = y, s

    return {
        "t": t,
        "x_true": truth[:, 0],
        "v_true": truth[:, 1],
        "z": z,
        "x_pred": x_pred,
        "P_pred00": P_pred00,
        "x_est": x_est,
        "v_est": v_est,
        "P00": P00,
        "P11": P11,
        "K0": K0,
        "K1": K1,
        "innov": innov,
        "S": S,
        "err_pos": x_est - truth[:, 0],
    }
`;

  function rmse(a, b) {
    const total = a.reduce((sum, value, index) => sum + Math.pow(value - b[index], 2), 0);
    return Math.sqrt(total / a.length);
  }

  function last(series) {
    return series[series.length - 1];
  }

  function convergenceSteps(result) {
    const threshold = 1.1 * Math.sqrt(last(result.P00));
    const index = result.P00.findIndex((value) => Math.sqrt(value) < threshold);
    return index < 0 ? NaN : index;
  }

  const DESCRIPTION = [
    '<p>Un mobile se déplace sur un axe. On ne mesure que sa <strong>position</strong>, avec un capteur bruité. ',
    'Le filtre de Kalman combine un <strong>modèle</strong> (vitesse constante) et les <strong>mesures</strong> pour estimer position <em>et</em> vitesse, avec leur incertitude.</p>',
    '<p class="equation-inline">x = [position, vitesse] · F = [[1, dt], [0, 1]] · H = [1, 0]<br>',
    'Q = σa² · [[dt⁴/4, dt³/2], [dt³/2, dt²]] · R = σz²</p>',
    '<p>Le filtre utilise <strong>ses propres hypothèses</strong> σa (Q) et σz (R), distinctes du système réel. ',
    'Essayez : σa très petit (le filtre croit trop son modèle et décroche), σz très petit (il suit le bruit des mesures), P0 petit avec une grosse erreur initiale (convergence lente).</p>'
  ].join('');

  App.registerSystem({
    id: 'kalman',
    name: 'Filtre de Kalman',
    subtitle: 'Suivi 1D position / vitesse à partir de mesures bruitées',
    description: DESCRIPTION,
    timeKey: 't',
    code: CODE,
    params: [
      { id: 'dt', label: 'Pas de temps', symbol: 'dt', unit: 's', min: 0.01, max: 1, step: 0.01, default: 0.1, group: 'Simulation', block: 'truth', advanced: true },
      { id: 'N', label: 'Nombre de pas', symbol: 'N', unit: '', min: 50, max: 1000, step: 10, default: 300, group: 'Simulation', block: 'truth', advanced: true },
      { id: 'seed', label: 'Graine aléatoire', symbol: 'seed', unit: '', min: 0, max: 9999, step: 1, default: 42, group: 'Simulation', block: 'truth', advanced: true },
      { id: 'a_amp', label: 'Amplitude de l\'accélération', symbol: 'a₀', unit: 'm/s²', min: 0, max: 5, step: 0.05, default: 0.5, group: 'Système réel', block: 'truth' },
      { id: 'a_period', label: 'Période de l\'accélération', symbol: 'Tₐ', unit: 's', min: 1, max: 60, step: 0.5, default: 12, group: 'Système réel', block: 'truth' },
      { id: 'sigma_a_true', label: 'Bruit d\'accélération réel', symbol: 'σa réel', unit: 'm/s²', min: 0, max: 3, step: 0.01, default: 0.2, group: 'Système réel', block: 'truth' },
      { id: 'sigma_z_true', label: 'Bruit du capteur réel', symbol: 'σz réel', unit: 'm', min: 0, max: 10, step: 0.05, default: 2, group: 'Système réel', block: 'measure' },
      { id: 'sigma_a', label: 'Bruit de processus supposé (Q)', symbol: 'σa', unit: 'm/s²', min: 0.001, max: 100, step: 0.001, default: 0.3, group: 'Filtre : prédiction', block: 'predict', log: true },
      { id: 'sigma_z', label: 'Bruit de mesure supposé (R)', symbol: 'σz', unit: 'm', min: 0.01, max: 100, step: 0.01, default: 2, group: 'Filtre : correction', block: 'update', log: true },
      { id: 'x0_err', label: 'Erreur initiale de position', symbol: 'Δx₀', unit: 'm', min: -50, max: 50, step: 0.5, default: 10, group: 'Initialisation', block: 'predict', advanced: true },
      { id: 'v0_err', label: 'Erreur initiale de vitesse', symbol: 'Δv₀', unit: 'm/s', min: -10, max: 10, step: 0.1, default: -2, group: 'Initialisation', block: 'predict', advanced: true },
      { id: 'P0', label: 'Incertitude initiale (P0 = p·I)', symbol: 'P₀', unit: '', min: 0.01, max: 10000, step: 0.01, default: 100, group: 'Initialisation', block: 'predict', log: true, advanced: true }
    ],
    diagram: {
      width: 1200,
      cycle: ['truth', 'measure', 'predict', 'update'],
      zones: [
        { label: 'MONDE RÉEL (SIMULÉ)', blocks: ['truth', 'measure'] },
        { label: 'FILTRE DE KALMAN', blocks: ['predict', 'update'] }
      ],
      blocks: [
        {
          id: 'truth', title: 'Système réel', kind: 'process', x: 44, row: 0, w: 340, h: 120,
          lines: ['xₖ = F xₖ₋₁ + G aₖ₋₁', 'a = a₀ sin(2πt/Tₐ) + bruit'],
          readouts: [{ label: 'xₖ', key: 'x_true', format: 3 }, { label: 'vₖ', key: 'v_true', format: 3 }],
          info: '<p>La trajectoire que l\'on cherche à retrouver. L\'accélération réelle <code>a</code> n\'est <strong>pas</strong> connue du filtre : il suppose une vitesse constante, perturbée par un bruit blanc d\'écart-type σa.</p>'
        },
        {
          id: 'measure', title: 'Capteur', kind: 'measure', x: 512, row: 0, w: 340, h: 120,
          lines: ['zₖ = H xₖ + vₖ', 'vₖ ~ N(0, σz réel²)'],
          readouts: [{ label: 'zₖ', key: 'z', format: 3 }, { label: 'zₖ − xₖ', key: (r, k) => r.z[k] - r.x_true[k], format: 3 }],
          info: '<p>Le capteur ne voit que la position (<code>H = [1, 0]</code>) et ajoute un bruit gaussien. La vitesse n\'est jamais mesurée : le filtre doit la <strong>déduire</strong> de l\'évolution des positions.</p>'
        },
        {
          id: 'predict', title: 'Prédiction', kind: 'estimate', x: 44, row: 1, w: 340, h: 130,
          lines: ['x̂⁻ = F x̂', 'P⁻ = F P Fᵀ + Q'],
          readouts: [
            { label: 'x̂⁻ₖ', key: 'x_pred', format: 3 },
            { label: '√P⁻₀₀', key: (r, k) => Math.sqrt(r.P_pred00[k]), format: 3 },
            { label: 'x̂⁻ₖ − xₖ', key: (r, k) => r.x_pred[k] - r.x_true[k], format: 3 }
          ],
          info: '<p>Le filtre fait avancer son estimation avec le modèle. L\'incertitude <code>P</code> <strong>augmente</strong> de <code>Q</code> : plus σa est grand, moins le filtre fait confiance à son modèle.</p><p>L\'initialisation (Δx₀, Δv₀, P₀, dans « Paramètres de simulation ») fixe le point de départ : un P₀ trop petit avec une grosse erreur initiale ralentit la convergence.</p>'
        },
        {
          id: 'update', title: 'Correction', kind: 'estimate', x: 512, row: 1, w: 340, h: 130,
          lines: ['S = H P⁻ Hᵀ + R', 'K = P⁻ Hᵀ S⁻¹', 'x̂ = x̂⁻ + K (z − H x̂⁻)', 'P = (I − K H) P⁻'],
          readouts: [
            { label: 'K₀', key: 'K0', format: 4 },
            { label: 'K₁', key: 'K1', format: 4 },
            { label: 'yₖ', key: 'innov', format: 3 }
          ],
          info: '<p>L\'innovation <code>y = z − H x̂⁻</code> mesure la surprise. Le gain <code>K</code> dose la correction : K₀ proche de 1, on suit la mesure ; proche de 0, on garde la prédiction.</p><p>K résulte du rapport entre l\'incertitude de prédiction <code>P⁻</code> et celle du capteur <code>R</code>. L\'incertitude <code>P</code> <strong>diminue</strong> après chaque mesure.</p>'
        },
        {
          id: 'output', title: 'Estimation', kind: 'io', x: 952, row: 1, w: 224, h: 100,
          lines: ['x̂ₖ = [p̂, v̂]', 'Pₖ = cov(x − x̂)'],
          readouts: [
            { label: 'x̂ₖ', key: 'x_est', format: 3 },
            { label: 'v̂ₖ', key: 'v_est', format: 3 },
            { label: '√P₀₀', key: (r, k) => Math.sqrt(r.P00[k]), format: 3 }
          ],
          info: '<p>La sortie du filtre à chaque instant : l\'état estimé (position <em>et</em> vitesse) et sa covariance <code>P</code>. L\'intervalle <code>x̂ₖ ± 2√P₀₀</code> contient la vraie position environ 95 % du temps si les hypothèses du filtre sont justes.</p>'
        }
      ],
      edges: [
        { from: 'truth', to: 'measure', label: 'xₖ', readout: { key: 'x_true', format: 3 } },
        { from: 'measure', to: 'update', label: 'zₖ', fromSide: 'bottom', toSide: 'top', readout: { key: 'z', format: 3 } },
        { from: 'predict', to: 'update', label: 'x̂⁻ₖ, P⁻' },
        { from: 'update', to: 'output', label: 'x̂ₖ', readout: { key: 'x_est', format: 3 } },
        { from: 'update', to: 'predict', label: 'k → k+1', fromSide: 'bottom', toSide: 'bottom', loop: true }
      ]
    },
    plots: [
      {
        id: 'position', title: 'Position', xKey: 't', yLabel: 'x (m)',
        traces: [
          { key: 'z', name: 'Mesures z', kind: 'markers', color: 'muted', size: 4 },
          { key: 'x_true', name: 'Vraie', kind: 'line', color: 'truth', width: 1.5 },
          { key: 'x_est', name: 'Estimée x̂', kind: 'line', color: 'series-1', band: { varianceKey: 'P00', n: 2, name: '±2√P₀₀' } }
        ]
      },
      {
        id: 'velocity', title: 'Vitesse (jamais mesurée)', xKey: 't', yLabel: 'v (m/s)',
        traces: [
          { key: 'v_true', name: 'Vraie', kind: 'line', color: 'truth', width: 1.5 },
          { key: 'v_est', name: 'Estimée v̂', kind: 'line', color: 'series-1', band: { varianceKey: 'P11', n: 2, name: '±2√P₁₁' } }
        ]
      },
      {
        id: 'gain', title: 'Gain de Kalman', xKey: 't', yLabel: 'K',
        traces: [
          { key: 'K0', name: 'K₀ (position)', kind: 'line', color: 'series-1' },
          { key: 'K1', name: 'K₁ (vitesse, 1/s)', kind: 'line', color: 'series-2' }
        ]
      },
      {
        id: 'innovation', title: 'Innovation y = z − H x̂⁻', xKey: 't', yLabel: 'y (m)',
        traces: [
          { key: 'innov', name: 'Innovation y', kind: 'line', color: 'series-1', width: 1, band: { varianceKey: 'S', n: 2, center: 0, name: '±2√S' } }
        ]
      }
    ],
    readouts: [
      { label: 'RMSE position · mesure brute', unit: 'm', format: 3, compute: (r) => rmse(r.z, r.x_true), hint: 'Erreur quadratique moyenne des mesures z par rapport à la vraie position.' },
      { label: 'RMSE position · estimée', unit: 'm', format: 3, compute: (r) => rmse(r.x_est, r.x_true), hint: 'Erreur quadratique moyenne de x̂ : comparez-la à celle des mesures brutes.' },
      { label: 'RMSE vitesse · estimée', unit: 'm/s', format: 3, compute: (r) => rmse(r.v_est, r.v_true), hint: 'La vitesse est déduite, jamais mesurée.' },
      { label: 'K₀ final', unit: '', format: 4, compute: (r) => last(r.K0), hint: 'Gain de position en régime établi.' },
      { label: 'Convergence', unit: 'pas', format: 'int', compute: convergenceSteps, hint: 'Nombre de pas pour que √P₀₀ passe sous 110 % de sa valeur finale.' }
    ]
  });
})(window.App = window.App || {});
