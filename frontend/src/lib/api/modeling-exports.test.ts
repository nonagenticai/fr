// fr's own choices around a model's downloads: which exchange format a model's
// language exports as, and the file names fr gives the files it saves.
import { describe, expect, test } from 'vitest';

import { MODEL_DOWNLOAD_SUFFIX, exchangeFormatOf, fileNameOf } from './modeling';

describe('exchangeFormatOf', () => {
  test('a UML model exports as XMI', () => {
    expect(exchangeFormatOf('uml')).toBe('xmi');
  });

  test('an ArchiMate model, or one whose language is not stated, exports as the Open Group exchange file', () => {
    expect(exchangeFormatOf('archimate')).toBe('archimate-exchange');
    expect(exchangeFormatOf(undefined)).toBe('archimate-exchange');
    expect(exchangeFormatOf(null)).toBe('archimate-exchange');
  });
});

describe('model download file names', () => {
  test('the SVG export is saved as a zip; PDF and XMI keep their own endings', () => {
    expect(fileNameOf('Order flow', MODEL_DOWNLOAD_SUFFIX.svg)).toBe('Order-flow.zip');
    expect(fileNameOf('Order flow', MODEL_DOWNLOAD_SUFFIX.pdf)).toBe('Order-flow.pdf');
    expect(fileNameOf('Order flow', MODEL_DOWNLOAD_SUFFIX.xmi)).toBe('Order-flow.xmi');
  });

  test('a title with no usable characters still gets a name', () => {
    expect(fileNameOf('***', MODEL_DOWNLOAD_SUFFIX.pdf)).toBe('model.pdf');
  });
});
