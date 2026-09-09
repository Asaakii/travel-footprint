/* 年度飞行报告逐屏交互：桌面滚轮按章节切换，移动端保留原生滑动。 */
(function () {
  "use strict";

  function initAnnualReport() {
    var root = document.getElementById("travel-report");
    if (!root || root.dataset.reportReady === "true") return;
    root.dataset.reportReady = "true";

    var deck = root.querySelector("[data-report-deck]");
    var slides = Array.prototype.slice.call(root.querySelectorAll("[data-report-slide]"));
    var progress = root.querySelector(".annual-report-progress span");
    var next = root.querySelector("[data-report-next]");
    if (!deck || !slides.length) return;

    var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var locked = false;
    var active = 0;

    function closestIndex() {
      var y = deck.scrollTop;
      var closest = 0;
      var distance = Infinity;
      slides.forEach(function (slide, index) {
        var nextDistance = Math.abs(slide.offsetTop - y);
        if (nextDistance < distance) {
          distance = nextDistance;
          closest = index;
        }
      });
      return closest;
    }

    function updateProgress(index) {
      active = Math.max(0, Math.min(index, slides.length - 1));
      if (progress) progress.style.width = ((active + 1) / slides.length * 100).toFixed(2) + "%";
    }

    function goTo(index) {
      var target = Math.max(0, Math.min(index, slides.length - 1));
      updateProgress(target);
      slides[target].scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    }

    if (next) {
      next.addEventListener("click", function () {
        goTo(1);
      });
    }

    if (!reduced && window.matchMedia("(pointer: fine)").matches) {
      deck.addEventListener("wheel", function (event) {
        if (Math.abs(event.deltaY) < 8 || locked) return;
        var current = closestIndex();
        var target = event.deltaY > 0 ? current + 1 : current - 1;
        if (target === current) return;
        event.preventDefault();
        locked = true;
        goTo(target);
        window.setTimeout(function () { locked = false; }, 560);
      }, { passive: false });
    }

    deck.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown" || event.key === "PageDown") {
        event.preventDefault();
        goTo(closestIndex() + 1);
      }
      if (event.key === "ArrowUp" || event.key === "PageUp") {
        event.preventDefault();
        goTo(closestIndex() - 1);
      }
      if (event.key === "Home") {
        event.preventDefault();
        goTo(0);
      }
      if (event.key === "End") {
        event.preventDefault();
        goTo(slides.length - 1);
      }
    });

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting && entry.intersectionRatio > 0.55) {
          updateProgress(slides.indexOf(entry.target));
        }
      });
    }, { root: deck, threshold: [0.56] });
    slides.forEach(function (slide) { observer.observe(slide); });

    updateProgress(0);
  }

  if (!window.__annualReportPjaxBound) {
    window.__annualReportPjaxBound = true;
    document.addEventListener("pjax:complete", initAnnualReport);
  }
  initAnnualReport();
})();
