/**
 * Flip card component for Mermaid-GPT.
 */
window.FlipCard = class FlipCard {
  constructor(cardEl) {
    this.card = cardEl;
    this.flipped = false;

    // Click on card body (but not on pan-zoom viewports) flips
    this.card.addEventListener('click', (e) => {
      // Only flip if the click is on the card itself or badge, not inside viewport
      if (e.target.closest('.pan-zoom-viewport')) return;
      this.toggle();
    });

    // Keyboard: Enter or Space flips
    this.card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.toggle();
      }
    });
  }

  toggle() {
    this.flipped = !this.flipped;
    this.card.classList.toggle('flipped', this.flipped);
  }

  showFront() {
    this.flipped = false;
    this.card.classList.remove('flipped');
  }

  showBack() {
    this.flipped = true;
    this.card.classList.add('flipped');
  }
};
