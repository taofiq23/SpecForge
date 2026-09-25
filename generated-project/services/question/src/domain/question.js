'use strict';

const { newId, fractionEquals } = require('@spacefractions/shared').domain;

/**
 * Question - the class named in the ClassDiagram (spec.json view 2):
 *
 *   class Question {
 *     - id: string
 *     - prompt: string
 *     - options: List<string>
 *     + getPrompt(): string
 *     + getOptions(): List<string>
 *   }
 *
 * QuestionComponent owns this aggregate; ASR-1 (data durability) requires it to
 * be persisted and recoverable, hence the SQL DDL in sql/question_ddl.sql.
 */
class Question {
  constructor(props = {}) {
    this.id = props.id || newId();
    this.prompt = props.prompt;
    this.options = Array.isArray(props.options) ? props.options.slice() : [];
    // Why the spec underspecifies this: the ClassDiagram lists id/prompt/options
    // only, but "check answer" in SequenceDiagram1 requires an answer key. We add
    // correctOption, which is never returned to students.
    this.correctOption = props.correctOption;
    this.difficulty = props.difficulty || 'medium';
    this.weight = Number.isFinite(props.weight) ? props.weight : 1;
    this.tags = Array.isArray(props.tags) ? props.tags.slice() : [];
    this.active = props.active === undefined ? true : Boolean(props.active);
    this.createdAt = props.createdAt || new Date().toISOString();
    this.updatedAt = props.updatedAt || new Date().toISOString();
    this.version = Number.isInteger(props.version) ? props.version : 1;
  }

  /** ClassDiagram: + getPrompt(): string */
  getPrompt() {
    return this.prompt;
  }

  /** ClassDiagram: + getOptions(): List<string> */
  getOptions() {
    return this.options.slice();
  }

  /** SequenceDiagram1: Question ->> Game : return result */
  checkAnswer(answer) {
    if (answer === null || answer === undefined) {
      return { correct: false, reason: 'empty_answer' };
    }
    const submitted = String(answer).trim();
    if (submitted === String(this.correctOption).trim()) {
      return { correct: true, reason: 'exact_match' };
    }
    // Accept equivalent fractions, e.g. "6/8" for "3/4". A learning tool should
    // not mark a mathematically correct answer wrong.
    if (submitted.includes('/') && String(this.correctOption).includes('/')) {
      if (fractionEquals(submitted, this.correctOption)) {
        return { correct: true, reason: 'equivalent_fraction' };
      }
    }
    return { correct: false, reason: 'mismatch', correctOption: this.correctOption };
  }

  validate() {
    const errors = [];
    if (!this.prompt || typeof this.prompt !== 'string' || this.prompt.trim().length < 3) {
      errors.push('prompt must be a string of at least 3 characters');
    }
    if (!Array.isArray(this.options) || this.options.length < 2) {
      errors.push('options must contain at least 2 entries');
    }
    if (this.options.some((o) => typeof o !== 'string' || o.trim() === '')) {
      errors.push('every option must be a non-empty string');
    }
    if (!this.correctOption || typeof this.correctOption !== 'string') {
      errors.push('correctOption is required');
    } else if (this.options.length > 0 && !this.options.includes(this.correctOption)) {
      errors.push('correctOption must be one of the options');
    }
    if (!['easy', 'medium', 'hard'].includes(this.difficulty)) {
      errors.push('difficulty must be one of easy, medium, hard');
    }
    return { valid: errors.length === 0, errors };
  }

  /** Student-facing projection - deliberately omits correctOption. */
  toPublicJSON() {
    return {
      id: this.id,
      prompt: this.prompt,
      options: this.getOptions(),
      difficulty: this.difficulty,
    };
  }

  toJSON() {
    return {
      id: this.id,
      prompt: this.prompt,
      options: this.options,
      correctOption: this.correctOption,
      difficulty: this.difficulty,
      weight: this.weight,
      tags: this.tags,
      active: this.active,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      version: this.version,
    };
  }

  static fromJSON(json) {
    if (!json) return null;
    return new Question(typeof json === 'string' ? JSON.parse(json) : json);
  }
}

module.exports = { Question };
