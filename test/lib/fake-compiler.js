'use strict';

/**
 * FakeCompiler — Deterministic compiler adapter for testing.
 * Wraps real mermaid-compiler and mermaid-validator.
 */

const realCompiler = require('../../server/services/mermaid-compiler');
const realValidator = require('../../server/services/mermaid-validator');

class FakeCompiler {
  constructor(options = {}) {
    this.mockCompileFn = options.mockCompileFn || null;
  }

  async compile(mmd, dir, name) {
    if (this.mockCompileFn) {
      return this.mockCompileFn(mmd, dir, name);
    }
    return realCompiler.compile(mmd, dir, name);
  }

  validate(mmd) {
    return realValidator.validate(mmd);
  }
}

module.exports = FakeCompiler;
