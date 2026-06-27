fetch("data/catalog.json", { cache: "no-cache" })
  .then((response) => response.ok ? response.json() : Promise.reject())
  .then((catalog) => {
    const count = document.getElementById("home-sound-count");
    if (count) count.textContent = new Intl.NumberFormat("pt-BR").format(catalog.length);
  })
  .catch(() => {});
