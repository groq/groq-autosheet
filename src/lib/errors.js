export class CellError {
  constructor(code, message = '') {
    this.code = code; // e.g. #NAME?, #REF!, #VALUE!, #DIV/0!, #N/A, #NUM!, #CYCLE!
    this.message = message;
  }

  toString() {
    return this.code;
  }
}

export const ERROR = {
  NAME: '#NAME?',
  REF: '#REF!',
  VALUE: '#VALUE!',
  DIV0: '#DIV/0!',
  NA: '#N/A',
  NUM: '#NUM!',
  CYCLE: '#CYCLE!'
};

export function isCellError(v) {
  return v instanceof CellError;
}

export function err(code, message) {
  return new CellError(code, message);
}


