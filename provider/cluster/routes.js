/**
 * Routen, die `resource-api` nicht kennt.
 *
 * Der Rahmen registriert sechs CRUD-Routen und sonst nichts; ein siebtes Verb
 * gibt es nicht. `createServer` gibt aber die Express-App zurueck, und
 * `authMiddleware` sowie das Logging sind dort app-weit ueber `app.use`
 * angemeldet - eine eigene Route erbt beides, ohne den Rahmen zu aendern.
 *
 * Eigene Datei, damit die Registrierung pruefbar ist. Lag sie in `server.js`,
 * liesse sie sich nur testen, indem man den echten Server startet - und genau
 * diese Naht hat heute schon einmal einen Ausfall gekostet, weil alle Tests
 * die Funktionen direkt aufriefen.
 */

/**
 * @param {object} app      Express-App aus createServer
 * @param {object} handlers die Operationen des Providers
 */
function registerRoutes(app, handlers) {
  /**
   * Die kubeconfig des Kindclusters.
   *
   * Nicht im Status und nicht in den Metriken: ein Cluster-Admin-Zugang darf
   * nicht in einer Antwort mitreisen, die geloggt und zwischengespeichert
   * wird. Was dort einmal steht, ist nicht mehr einzufangen.
   */
  app.get('/v1/clusters/:id/kubeconfig', async (req, res) => {
    const result = await handlers.kubeconfig({ id: req.params.id });

    if (!result.success) {
      // 409 waehrend des Baus - nichts ist falsch, es ist nur noch nicht da.
      // 500 bleibt dem echten Fehler.
      return res.status(result.pending ? 409 : 500).json(result);
    }

    res.json(result);
  });

  /**
   * Messwerte ueber Zeit.
   *
   * Eine eigene Route und kein Teil von `metrics`: der Momentanwert wird oft
   * und von einem Waechter abgerufen, eine Linie nur, wenn jemand hinsieht.
   * Beides in eine Antwort zu legen heisst, dreissig Tage mitzuschleppen,
   * wann immer eine Kachel aktualisiert wird.
   */
  app.get('/v1/clusters/:id/series', async (req, res) => {
    const result = await handlers.series({ id: req.params.id, range: req.query.range });

    if (!result.success) {
      // Ein unbekannter Zeitbereich ist ein Fehler des Aufrufers, kein
      // Ausfall - 400, damit es nicht wie ein Serverproblem aussieht.
      const badRange = /^Unknown range/.test(result.error || '');
      return res.status(badRange ? 400 : 500).json(result);
    }

    res.json(result);
  });

  /**
   * Der Zugang, den ein Sprung aus der Console braucht.
   *
   * `POST`, obwohl es sich wie ein Lesen anfuehlt: der Aufruf **legt an** -
   * eine Grafana-Organisation, Datenquellen, einen Nutzer, einen VMUser. Ein
   * `GET`, das schreibt, darf nicht zwischengespeichert werden, und genau das
   * wuerde irgendwann jemand tun.
   *
   * `409` fuer "es gibt dort nichts zu oeffnen" - ein Private Cluster hat
   * keinen regionalen Cluster und damit kein Grafana. Das ist kein Fehler
   * dieses Dienstes, sondern eine Eigenschaft der Variante, und der Aufrufer
   * soll es dem Menschen sagen koennen, statt eine 500 anzuzeigen.
   */
  app.post('/v1/clusters/:id/dashboard-access', async (req, res) => {
    const result = await handlers.dashboardAccess({
      id: req.params.id,
      tenantId: req.body && req.body.tenantId,
      email: req.body && req.body.email,
      name: req.body && req.body.name,
      grafanaUrl: req.body && req.body.grafanaUrl,
    });

    if (!result.success) {
      if (result.available === false) return res.status(409).json(result);
      // Ein fehlendes Feld ist ein Fehler des Aufrufers, kein Ausfall.
      const missing = /^Missing required field/.test(result.error || '');
      return res.status(missing ? 400 : 500).json(result);
    }

    res.json(result);
  });

  return app;
}

module.exports = { registerRoutes };
