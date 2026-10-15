
(() => {
  "use strict";

  const API_URL = "/api/my-collection";
  const PAGE_SIZE = 50;
  const CONCURRENCY = 3;
  const MAX_ATTEMPTS = 4;

  const PRICE_API_PREFIX = "/api/marketplace/cards/";
  const PRICE_CACHE_PREFIX = "wm-duplicates-average-";
  const PRICE_CACHE_TTL = 10 * 60 * 1000;
  const PRICE_ERROR_CACHE_TTL = 60 * 1000;

  const ALLOWED_RARITIES = ["L", "UR", "SR", "R", "PC", "C"];

  const SALE_DURATIONS = [
    { value: 10, label: "10 minutes" },
    { value: 30, label: "30 minutes" },
    { value: 60, label: "1 heure" },
    { value: 180, label: "3 heures" },
    { value: 360, label: "6 heures" },
    { value: 720, label: "12 heures" }
  ];

  const BUTTON_ID = "wm-duplicates-button";
  const MODAL_ID = "wm-duplicates-modal";

  const PRICE_KEY = "wm-duplicates-sale-price";
  const DURATION_KEY = "wm-duplicates-sale-duration";

  let isLoading = false;

  const activeSales = new Set();
  const activeDiscards = new Set();
  const averagePromises = new Map();
  const averageMemoryCache = new Map();

  // --------------------------------------------------
  // CONFIGURATION ET SAUVEGARDE
  // --------------------------------------------------

  function readSetting(key, fallback) {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveSetting(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch (error) {
      console.warn(
        "[WikiMasters] Impossible de sauvegarder le réglage.",
        error
      );
    }
  }

  function getDefaultSalePrice() {
    const value = Number(readSetting(PRICE_KEY, "100"));

    return Number.isSafeInteger(value) && value > 0 ? value : 100;
  }

  function getSaleSettings(priceInput) {
    const durationInput = document.getElementById("wm-sale-duration");

    const price = Number(priceInput?.value);
    const duration = Number(durationInput?.value);

    if (!Number.isSafeInteger(price) || price <= 0) {
      throw new Error("Le prix de vente doit être un entier positif.");
    }

    if (!SALE_DURATIONS.some(option => option.value === duration)) {
      throw new Error(
        "Choisis une durée de vente parmi les options proposées."
      );
    }

    saveSetting(PRICE_KEY, price);
    saveSetting(DURATION_KEY, duration);

    return { price, duration };
  }

  // --------------------------------------------------
  // BOUTON PRINCIPAL
  // --------------------------------------------------

  function createButton() {
    if (document.getElementById(BUTTON_ID)) return;

    const button = document.createElement("button");

    button.id = BUTTON_ID;
    button.type = "button";
    button.textContent = "Mes doublons";
    button.title = "Afficher les cartes en double";

    button.addEventListener("click", openDuplicates);

    document.body.appendChild(button);
  }

  // --------------------------------------------------
  // REQUÊTES API AVEC TENTATIVES
  // --------------------------------------------------

  async function requestJson(url, options = {}, label = "API") {
    let lastError;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(url, {
          credentials: "include",
          ...options,
          headers: {
            Accept: "application/json",
            ...(options.headers || {})
          }
        });

        if (response.ok) {
          if (response.status === 204) return null;

          const contentType = response.headers.get("content-type") || "";

          if (!contentType.includes("application/json")) {
            return null;
          }

          return await response.json();
        }

        const retryable =
          response.status === 429 ||
          [500, 502, 503, 504].includes(response.status);

        if (!retryable || attempt === MAX_ATTEMPTS) {
          let details = "";

          try {
            const body = await response.clone().json();
            details = body?.error || body?.message || "";
          } catch (_) {}

          throw new Error(
            `${label} : HTTP ${response.status}` +
            (details ? ` — ${details}` : "")
          );
        }

        lastError = new Error(`${label} : HTTP ${response.status}`);

        const retryAfter = Number(response.headers.get("Retry-After"));
        const delay =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 10000)
            : 1000 * attempt;

        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      } catch (error) {
        lastError = error;

        const statusMatch = String(error?.message || "").match(/HTTP (\d+)/);
        const status = statusMatch ? Number(statusMatch[1]) : null;

        if (status !== null && status < 500 && status !== 429) {
          throw error;
        }

        if (attempt === MAX_ATTEMPTS) {
          throw error;
        }
      }

      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }

    throw lastError || new Error(`${label} : erreur inconnue.`);
  }

  async function fetchPage(page, includeStats = false) {
    const url = new URL(API_URL, location.origin);

    url.searchParams.set("sort", "rarity");
    url.searchParams.set("page", String(page));
    url.searchParams.set("stats", includeStats ? "1" : "0");

    const data = await requestJson(
      url.href,
      { method: "GET" },
      `Récupération de la page ${page}`
    );

    if (!Array.isArray(data?.collection)) {
      throw new Error(
        `La page ${page} ne contient pas de collection valide.`
      );
    }

    return data;
  }

  // --------------------------------------------------
  // RÉCUPÉRATION DE TOUTE LA COLLECTION
  // --------------------------------------------------

  async function fetchCollection() {
    const allEntries = [];
    const seenEntryIds = new Set();

    function addEntries(entries) {
      for (const entry of entries) {
        if (entry.id != null && seenEntryIds.has(String(entry.id))) {
          continue;
        }

        if (entry.id != null) {
          seenEntryIds.add(String(entry.id));
        }

        allEntries.push(entry);
      }
    }

    const firstPage = await fetchPage(0, true);
    addEntries(firstPage.collection);

    const total = Number(firstPage.total);

    if (!Number.isFinite(total) || total < 0) {
      throw new Error(
        "Impossible de déterminer le nombre total de cartes."
      );
    }

    const pageCount = Math.ceil(total / PAGE_SIZE);

    updateProgress(1, pageCount, allEntries.length);

    for (let start = 1; start < pageCount; start += CONCURRENCY) {
      const end = Math.min(start + CONCURRENCY, pageCount);

      const pageNumbers = Array.from(
        { length: end - start },
        (_, index) => start + index
      );

      const results = await Promise.all(
        pageNumbers.map(page => fetchPage(page))
      );

      for (const data of results) {
        addEntries(data.collection);
      }

      updateProgress(end, pageCount, allEntries.length);

      console.log(
        `[WikiMasters] ${end}/${pageCount} pages traitées — ` +
        `${allEntries.length} entrées récupérées.`
      );
    }

    return allEntries;
  }

  // --------------------------------------------------
  // DÉTECTION DES DOUBLONS
  // --------------------------------------------------

  function findDuplicates(entries) {
    const groups = new Map();

    for (const entry of entries) {
      if (!entry.card_id || !entry.card) continue;

      const shiny = Boolean(entry.is_shiny);
      const key = `${entry.card_id}:${shiny}`;

      if (!groups.has(key)) {
        groups.set(key, {
          cardId: entry.card_id,
          shiny,
          card: entry.card,
          count: 0
        });
      }

      const group = groups.get(key);
      const quantity = Number(entry.count);

      group.count +=
        Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
    }

    return [...groups.values()]
      .filter(group => group.count > 1)
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;

        return (a.card.wikipedia_title || "").localeCompare(
          b.card.wikipedia_title || "",
          "fr"
        );
      });
  }

  // --------------------------------------------------
  // PRIX MOYENS DU MARCHÉ
  // --------------------------------------------------

  function getPriceCacheKey(cardId) {
    return `${PRICE_CACHE_PREFIX}${cardId}`;
  }

  function readPriceCache(cardId) {
    const memoryEntry = averageMemoryCache.get(String(cardId));

    if (
      memoryEntry &&
      Date.now() - memoryEntry.fetchedAt < memoryEntry.ttl
    ) {
      return memoryEntry;
    }

    try {
      const raw = localStorage.getItem(getPriceCacheKey(cardId));
      if (!raw) return null;

      const entry = JSON.parse(raw);

      if (
        !entry ||
        !Number.isFinite(entry.fetchedAt) ||
        !Number.isFinite(entry.ttl) ||
        Date.now() - entry.fetchedAt >= entry.ttl
      ) {
        return null;
      }

      averageMemoryCache.set(String(cardId), entry);
      return entry;
    } catch (_) {
      return null;
    }
  }

  function savePriceCache(cardId, entry) {
    averageMemoryCache.set(String(cardId), entry);

    try {
      localStorage.setItem(
        getPriceCacheKey(cardId),
        JSON.stringify(entry)
      );
    } catch (error) {
      console.debug(
        "[WikiMasters] Cache du prix moyen non sauvegardé.",
        error
      );
    }
  }

  function parseAverageResponse(json) {
    if (
      !json?.summary ||
      typeof json.summary !== "object" ||
      Array.isArray(json.summary)
    ) {
      throw new Error("Résumé des ventes invalide.");
    }

    const averages = {};

    for (const [rarity, value] of Object.entries(json.summary)) {
      if (!ALLOWED_RARITIES.includes(rarity) || !value) continue;

      const average = Number(value.average);

      if (Number.isFinite(average) && average >= 0) {
        averages[rarity] = average;
      }
    }

    return averages;
  }

  async function fetchCardAverage(cardId) {
    const id = String(cardId);

    const cached = readPriceCache(id);
    if (cached) return cached;

    if (averagePromises.has(id)) {
      return averagePromises.get(id);
    }

    const promise = (async () => {
      try {
        const url = new URL(
          `${PRICE_API_PREFIX}${encodeURIComponent(id)}/sales`,
          location.origin
        );

        url.searchParams.set("scope", "summary");

        const json = await requestJson(
          url.href,
          { method: "GET" },
          `Prix moyen de la carte ${id}`
        );

        const entry = {
          fetchedAt: Date.now(),
          ttl: PRICE_CACHE_TTL,
          ok: true,
          averages: parseAverageResponse(json)
        };

        savePriceCache(id, entry);
        return entry;
      } catch (error) {
        const entry = {
          fetchedAt: Date.now(),
          ttl: PRICE_ERROR_CACHE_TTL,
          ok: false,
          averages: {},
          error: String(error?.message || error)
        };

        savePriceCache(id, entry);

        console.warn(
          `[WikiMasters] Impossible de récupérer le prix moyen de ${id}.`,
          error
        );

        return entry;
      } finally {
        averagePromises.delete(id);
      }
    })();

    averagePromises.set(id, promise);
    return promise;
  }

  function getAverageForRarity(entry, rarity) {
    if (!entry?.ok || !rarity) return null;

    const average = entry.averages?.[rarity];

    return Number.isFinite(average) && average >= 0
      ? average
      : null;
  }

  function formatPrice(value) {
    return value.toLocaleString("fr-FR", {
      maximumFractionDigits: 2
    });
  }

  function updateCardAverageUI(duplicate, priceEntry) {
    const key = `${duplicate.cardId}:${duplicate.shiny}`;
    const row = document.querySelector(
      `[data-wm-duplicate-key="${CSS.escape(key)}"]`
    );

    if (!row) return;

    const averageElement = row.querySelector(".wm-duplicate-average");
    const priceInput = row.querySelector(".wm-sale-card-price");
    const useAverageButton = row.querySelector(".wm-sale-use-average");

    if (!averageElement || !priceInput || !useAverageButton) return;

    const average = getAverageForRarity(
      priceEntry,
      duplicate.card.rarity
    );

    if (average === null) {
      averageElement.textContent = priceEntry?.ok
        ? "Prix moyen indisponible pour cette rareté."
        : "Prix moyen indisponible (erreur de chargement).";

      averageElement.classList.add("wm-average-unavailable");
      useAverageButton.disabled = true;
      useAverageButton.title =
        "Aucune moyenne disponible pour cette rareté.";

      return;
    }

    averageElement.textContent = `Prix moyen : ${formatPrice(average)}`;
    averageElement.classList.remove("wm-average-unavailable");

    useAverageButton.disabled = false;
    useAverageButton.title = "Utiliser le prix moyen comme prix de vente";

    if (priceInput.dataset.userEdited !== "true") {
      priceInput.value = String(Math.round(average));
    }

    useAverageButton.onclick = () => {
      priceInput.value = String(Math.round(average));
      priceInput.dataset.userEdited = "false";
      saveSetting(PRICE_KEY, priceInput.value);
    };
  }

  async function loadCardAverages(duplicates) {
    const uniqueCards = [
      ...new Map(
        duplicates.map(duplicate => [
          String(duplicate.cardId),
          duplicate
        ])
      ).values()
    ];

    let nextIndex = 0;

    async function worker() {
      while (nextIndex < uniqueCards.length) {
        const duplicate = uniqueCards[nextIndex++];
        const entry = await fetchCardAverage(duplicate.cardId);

        for (const sameCard of duplicates) {
          if (String(sameCard.cardId) === String(duplicate.cardId)) {
            updateCardAverageUI(sameCard, entry);
          }
        }
      }
    }

    await Promise.all(
      Array.from(
        { length: Math.min(CONCURRENCY, uniqueCards.length) },
        () => worker()
      )
    );
  }

  // --------------------------------------------------
  // ÉLÉMENTS HTML
  // --------------------------------------------------

  function createElement(tag, className, text) {
    const element = document.createElement(tag);

    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;

    return element;
  }

  // --------------------------------------------------
  // PROGRESSION DU CHARGEMENT
  // --------------------------------------------------

  function updateProgress(currentPage, totalPages, totalEntries) {
    const content = document.querySelector(
      `#${MODAL_ID} .wm-duplicates-content`
    );

    if (!content) return;

    const percent = totalPages > 0
      ? Math.min(100, Math.floor((currentPage / totalPages) * 100))
      : 100;

    content.replaceChildren();

    const label = createElement(
      "p",
      "wm-duplicates-summary",
      `Récupération des cartes : ${currentPage} / ${totalPages} pages`
    );

    const progressContainer = createElement(
      "div",
      "wm-duplicates-progress-container"
    );

    progressContainer.style.cssText =
      "width:100%;height:12px;margin:16px 0;overflow:hidden;" +
      "border-radius:999px;background-color:#333";

    const progressBar = createElement("div", "wm-duplicates-progress-bar");

    progressBar.style.cssText =
      `width:${percent}%;height:100%;border-radius:999px;` +
      "background-color:#16a34a;transition:width .2s ease";

    progressContainer.appendChild(progressBar);

    content.append(
      label,
      progressContainer,
      createElement("p", "wm-duplicates-hint", `${percent} %`),
      createElement(
        "p",
        "wm-duplicates-hint",
        `${totalEntries.toLocaleString("fr-FR")} entrées récupérées`
      )
    );
  }

  // --------------------------------------------------
  // FENÊTRE
  // --------------------------------------------------

  function closeModal() {
    document.getElementById(MODAL_ID)?.remove();
  }

  function showLoading() {
    closeModal();

    const overlay = createElement("div", "wm-duplicates-overlay");
    overlay.id = MODAL_ID;

    const panel = createElement("section", "wm-duplicates-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "wm-duplicates-title");

    const header = createElement("div", "wm-duplicates-header");
    const title = createElement("h2", "", "Mes doublons");
    title.id = "wm-duplicates-title";

    const close = createElement("button", "wm-duplicates-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Fermer");
    close.addEventListener("click", closeModal);

    header.append(title, close);

    const content = createElement(
      "div",
      "wm-duplicates-content",
      "Connexion à ta collection…"
    );

    panel.append(header, content);
    overlay.appendChild(panel);

    overlay.addEventListener("click", event => {
      if (event.target === overlay) closeModal();
    });

    document.body.appendChild(overlay);

    return content;
  }

  // --------------------------------------------------
  // CONFIGURATION DES DURÉES
  // --------------------------------------------------

  function createSaleSettings() {
    const box = createElement("section", "wm-sale-settings");
    const heading = createElement("h3", "", "Paramètres de vente");

    const durationLabel = createElement(
      "label",
      "wm-sale-label",
      "Durée de l'annonce"
    );

    durationLabel.htmlFor = "wm-sale-duration";

    const durationSelect = createElement("select", "wm-sale-input");
    durationSelect.id = "wm-sale-duration";

    const savedDuration = Number(readSetting(DURATION_KEY, "60"));

    for (const option of SALE_DURATIONS) {
      const optionElement = document.createElement("option");

      optionElement.value = String(option.value);
      optionElement.textContent = option.label;
      optionElement.selected = option.value === savedDuration;

      durationSelect.appendChild(optionElement);
    }

    if (!SALE_DURATIONS.some(option => option.value === savedDuration)) {
      durationSelect.value = "60";
    }

    durationSelect.addEventListener("change", () => {
      saveSetting(DURATION_KEY, durationSelect.value);
    });

    const hint = createElement(
      "p",
      "wm-duplicates-hint",
      "Le prix est défini sur chaque carte à partir de sa moyenne " +
      "lorsqu'elle est disponible. Tu peux toujours le modifier."
    );

    const durationGroup = createElement("div", "wm-sale-field");
    durationGroup.append(durationLabel, durationSelect);

    const fields = createElement("div", "wm-sale-fields");
    fields.appendChild(durationGroup);

    box.append(heading, fields, hint);

    return box;
  }

  // --------------------------------------------------
  // RECHERCHE D'UN EXEMPLAIRE POSSÉDÉ
  // --------------------------------------------------

  async function fetchOwnedCandidates(duplicate) {
    const title = String(duplicate.card.wikipedia_title || "").trim();

    if (!title || !duplicate.cardId) {
      throw new Error("Impossible d'identifier cette carte.");
    }

    const candidates = [];
    let page = 0;
    let totalPages = 1;

    while (page < totalPages) {
      const url = new URL(API_URL, location.origin);

      url.searchParams.set("sort", "rarity");
      url.searchParams.set("q", title);
      url.searchParams.set("page", String(page));
      url.searchParams.set("stats", page === 0 ? "1" : "0");

      const data = await requestJson(
        url.href,
        { method: "GET" },
        "Recherche d'un exemplaire"
      );

      if (!Array.isArray(data?.collection)) {
        throw new Error(
          "Réponse invalide pendant la recherche de l'exemplaire."
        );
      }

      for (const entry of data.collection) {
        if (
          String(entry.card_id) === String(duplicate.cardId) &&
          Boolean(entry.is_shiny) === duplicate.shiny &&
          entry.id != null
        ) {
          candidates.push({
            ownedCardId: entry.id,
            starred: Boolean(entry.starred)
          });
        }
      }

      if (page === 0) {
        const total = Number(data.total);
        const pageSize = data.collection.length;

        totalPages =
          Number.isFinite(total) && total > 0 && pageSize > 0
            ? Math.ceil(total / pageSize)
            : 1;
      }

      page++;
    }

    if (!candidates.length) {
      throw new Error(
        "Aucun exemplaire correspondant n'a été retrouvé dans ta collection."
      );
    }

    return candidates;
  }

  async function fetchMyListings() {
    return requestJson(
      new URL("/api/marketplace/mine", location.origin).href,
      { method: "GET" },
      "Vérification des ventes existantes"
    );
  }

  // --------------------------------------------------
  // MISE EN VENTE
  // --------------------------------------------------

  async function createListing(
    duplicate,
    button,
    status,
    priceInput
  ) {
    const saleKey = `${duplicate.cardId}:${duplicate.shiny}`;

    if (activeSales.has(saleKey)) return;

    activeSales.add(saleKey);
    button.disabled = true;
    button.textContent = "Recherche…";
    status.textContent = "";

    try {
      const { price, duration } = getSaleSettings(priceInput);

      const mine = await fetchMyListings();
      const mineText = JSON.stringify(mine ?? {});

      const candidates = await fetchOwnedCandidates(duplicate);

      candidates.sort((a, b) => Number(a.starred) - Number(b.starred));

      const available = candidates.find(
        candidate => !mineText.includes(String(candidate.ownedCardId))
      );

      if (!available) {
        throw new Error(
          "Toutes les copies retrouvées semblent déjà en vente."
        );
      }

      if (available.starred) {
        const confirmed = window.confirm(
          "L'exemplaire choisi est en favori.\n\n" +
          "Veux-tu quand même le mettre en vente ?"
        );

        if (!confirmed) {
          status.textContent = "Vente annulée.";
          status.className = "wm-sale-status";
          return;
        }
      }

      button.textContent = "Mise en vente…";

      await requestJson(
        new URL("/api/marketplace", location.origin).href,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            card_id: available.ownedCardId,
            base_amount: price,
            duration_minutes: duration
          })
        },
        "Mise en vente"
      );

      status.textContent = "Mise en vente réussie !";
      status.className = "wm-sale-status wm-sale-success";

      button.textContent = "En vente";
      button.classList.add("wm-sale-listed");
      button.disabled = true;

      console.log("[WikiMasters] Annonce créée :", {
        cardId: duplicate.cardId,
        ownedCardId: available.ownedCardId,
        price,
        duration
      });
    } catch (error) {
      status.textContent = error instanceof Error
        ? error.message
        : "Une erreur inconnue est survenue.";

      status.className = "wm-sale-status wm-sale-error";
      button.textContent = "Réessayer";
      button.disabled = false;

      console.error(
        "[WikiMasters] Échec de la mise en vente :",
        error
      );
    } finally {
      activeSales.delete(saleKey);
    }
  }

  // --------------------------------------------------
  // DÉFAUSSE D'UN EXEMPLAIRE
  // --------------------------------------------------

  async function discardDuplicate(duplicate, button, status) {
    const discardKey = `${duplicate.cardId}:${duplicate.shiny}`;

    if (activeDiscards.has(discardKey)) return;

    const title = duplicate.card.wikipedia_title || "cette carte";

    const confirmed = window.confirm(
      `Défausser un exemplaire de « ${title} » ?\n\n` +
      "Cette action peut être définitive."
    );

    if (!confirmed) return;

    activeDiscards.add(discardKey);

    button.disabled = true;
    button.textContent = "Recherche…";
    status.textContent = "";
    status.className = "wm-sale-status";

    try {
      // Retrouve les exemplaires réellement possédés.
      const candidates = await fetchOwnedCandidates(duplicate);

      // On privilégie toujours un exemplaire qui n'est pas en favori.
      candidates.sort((a, b) => Number(a.starred) - Number(b.starred));

      const selected = candidates.find(candidate => !candidate.starred)
        || candidates[0];

      if (selected.starred) {
        const confirmedFavorite = window.confirm(
          `L'exemplaire de « ${title} » choisi est en favori.\n\n` +
          "Veux-tu quand même le défausser ?"
        );

        if (!confirmedFavorite) {
          status.textContent = "Défausse annulée.";
          button.textContent = "Défausser";
          button.disabled = false;
          return;
        }
      }

      button.textContent = "Défausse…";

      // L'API attend l'identifiant de l'exemplaire possédé.
      // La requête POST n'a pas de corps.
      const url = new URL(
        `/api/user-cards/${encodeURIComponent(selected.ownedCardId)}/discard`,
        location.origin
      );

      await requestJson(
        url.href,
        { method: "POST" },
        "Défausse"
      );

      console.log("[WikiMasters] Défausse réussie :", {
        cardId: duplicate.cardId,
        ownedCardId: selected.ownedCardId
      });

      status.textContent = "Défausse réussie. Actualisation…";
      status.className = "wm-sale-status wm-sale-success";

      // Recharge les données du serveur pour obtenir le vrai compteur,
      // sans supposer qu'un exemplaire correspond forcément à count = 1.
      const content = document.querySelector(
        `#${MODAL_ID} .wm-duplicates-content`
      );

      if (!content) return;

      try {
        const entries = await fetchCollection();
        const duplicates = findDuplicates(entries);

        renderDuplicates(content, duplicates, entries.length);
      } catch (refreshError) {
        // La défausse a réussi, mais le rafraîchissement peut échouer.
        content.replaceChildren();

        content.appendChild(createElement(
          "div",
          "wm-duplicates-error",
          "La défausse a réussi, mais l'actualisation de la collection " +
          "a échoué. Ferme puis rouvre la fenêtre pour actualiser les données. " +
          (refreshError instanceof Error ? refreshError.message : "")
        ));

        const retry = createElement(
          "button",
          "wm-duplicates-retry",
          "Actualiser la collection"
        );

        retry.type = "button";
        retry.addEventListener("click", openDuplicates);

        content.appendChild(retry);

        console.error(
          "[WikiMasters] Défausse réussie, mais actualisation impossible :",
          refreshError
        );
      }
    } catch (error) {
      status.textContent = error instanceof Error
        ? error.message
        : "Une erreur inconnue est survenue.";

      status.className = "wm-sale-status wm-sale-error";
      button.textContent = "Réessayer";
      button.disabled = false;

      console.error(
        "[WikiMasters] Échec de la défausse :",
        error
      );
    } finally {
      activeDiscards.delete(discardKey);
    }
  }

  // --------------------------------------------------
  // AFFICHAGE DES DOUBLONS
  // --------------------------------------------------

  function renderDuplicates(content, duplicates, totalEntries) {
    content.replaceChildren();

    content.appendChild(createElement(
      "p",
      "wm-duplicates-summary",
      `${totalEntries.toLocaleString("fr-FR")} entrées analysées · ` +
      `${duplicates.length} carte(s) en double`
    ));

    content.appendChild(createSaleSettings());

    if (duplicates.length === 0) {
      content.appendChild(createElement(
        "div",
        "wm-duplicates-empty",
        "Aucun doublon détecté dans la collection chargée."
      ));

      content.appendChild(createElement(
        "p",
        "wm-duplicates-hint",
        "Si tu possèdes des doublons, vérifie que la collection " +
        "a été récupérée intégralement."
      ));

      return;
    }

    const list = createElement("div", "wm-duplicates-list");

    for (const duplicate of duplicates) {
      const card = duplicate.card;
      const key = `${duplicate.cardId}:${duplicate.shiny}`;

      const item = createElement("article", "wm-duplicate-item");
      item.dataset.wmDuplicateKey = key;

      const image = createElement("img", "wm-duplicate-image");

      image.alt = card.wikipedia_title || "Carte WikiMasters";
      image.loading = "lazy";

      if (card.image_url) {
        image.src = card.image_url;
      } else {
        image.classList.add("wm-duplicate-image-missing");
      }

      image.addEventListener("error", () => {
        image.style.visibility = "hidden";
      });

      const info = createElement("div", "wm-duplicate-info");

      const name = createElement(
        "div",
        "wm-duplicate-name",
        card.wikipedia_title || "Carte sans nom"
      );

      const rarity = createElement(
        "div",
        "wm-duplicate-rarity",
        `Rareté : ${card.rarity || "inconnue"}`
      );

      const details = createElement(
        "div",
        "wm-duplicate-details",
        duplicate.shiny ? "Version shiny" : "Version normale"
      );

      const average = createElement(
        "div",
        "wm-duplicate-average",
        "Chargement du prix moyen…"
      );

      info.append(name, rarity, details, average);

      const count = createElement(
        "div",
        "wm-duplicate-count",
        `×${duplicate.count}`
      );

      const saleArea = createElement("div", "wm-duplicate-sale");

      const priceLabel = createElement(
        "label",
        "wm-sale-card-price-label",
        "Prix de vente"
      );

      const priceInput = createElement(
        "input",
        "wm-sale-input wm-sale-card-price"
      );

      priceInput.type = "number";
      priceInput.min = "1";
      priceInput.step = "1";
      priceInput.inputMode = "numeric";
      priceInput.value = String(getDefaultSalePrice());

      priceInput.addEventListener("input", () => {
        priceInput.dataset.userEdited = "true";

        if (priceInput.value !== "") {
          saveSetting(PRICE_KEY, priceInput.value);
        }
      });

      priceLabel.appendChild(priceInput);

      const useAverageButton = createElement(
        "button",
        "wm-sale-use-average",
        "Utiliser la moyenne"
      );

      useAverageButton.type = "button";
      useAverageButton.disabled = true;

      const saleButton = createElement(
        "button",
        "wm-sale-button",
        "Mettre en vente"
      );

      saleButton.type = "button";

      const saleStatus = createElement("p", "wm-sale-status");

      saleButton.addEventListener("click", () => {
        createListing(duplicate, saleButton, saleStatus, priceInput);
      });

      // Nouveau bouton de défausse.
      const discardButton = createElement(
        "button",
        "wm-discard-button",
        "Défausser"
      );

      discardButton.type = "button";
      discardButton.title = "Défausser un exemplaire de cette carte";

      const discardStatus = createElement("p", "wm-sale-status");

      discardButton.addEventListener("click", () => {
        discardDuplicate(duplicate, discardButton, discardStatus);
      });

      saleArea.append(
        priceLabel,
        useAverageButton,
        saleButton,
        saleStatus,
        discardButton,
        discardStatus
      );

      item.append(image, info, count, saleArea);
      list.appendChild(item);
    }

    content.appendChild(list);

    loadCardAverages(duplicates).catch(error => {
      console.error(
        "[WikiMasters] Échec du chargement des prix moyens :",
        error
      );
    });
  }

  // --------------------------------------------------
  // LANCEMENT DE L'ANALYSE
  // --------------------------------------------------

  async function openDuplicates() {
    if (isLoading) return;

    isLoading = true;

    const button = document.getElementById(BUTTON_ID);

    if (button) {
      button.disabled = true;
      button.textContent = "Analyse…";
    }

    const content = showLoading();

    try {
      const entries = await fetchCollection();
      const duplicates = findDuplicates(entries);

      renderDuplicates(content, duplicates, entries.length);
    } catch (error) {
      content.replaceChildren();

      content.appendChild(createElement(
        "div",
        "wm-duplicates-error",
        error instanceof Error
          ? error.message
          : "Une erreur inconnue est survenue."
      ));

      const retry = createElement(
        "button",
        "wm-duplicates-retry",
        "Réessayer"
      );

      retry.type = "button";
      retry.addEventListener("click", openDuplicates);

      content.appendChild(retry);

      console.error(
        "[WikiMasters] Échec de l'analyse des doublons :",
        error
      );
    } finally {
      isLoading = false;

      const currentButton = document.getElementById(BUTTON_ID);

      if (currentButton) {
        currentButton.disabled = false;
        currentButton.textContent = "Mes doublons";
      }
    }
  }

  // --------------------------------------------------
  // RACCOURCI ÉCHAP
  // --------------------------------------------------

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeModal();
  });

  // --------------------------------------------------
  // INITIALISATION
  // --------------------------------------------------

  createButton();

  const observer = new MutationObserver(createButton);

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();