import { useEffect, useId, useRef } from 'react';
import { Input } from '@mantine/core';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { classHighlighter } from '@lezer/highlight';

const MAX_COMMAND_LENGTH = 32768;

export default function BashEditor({ value, onChange, disabled, label, hint }: {
  value: string; onChange: (value: string) => void; disabled: boolean; label: string; hint: string;
}) {
  const id = useId();
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const settings = useRef(new Compartment());
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        extensions: [
          history(), keymap.of([...defaultKeymap, ...historyKeymap]),
          StreamLanguage.define(shell), syntaxHighlighting(classHighlighter),
          EditorView.lineWrapping, settings.current.of([]),
          EditorState.transactionFilter.of(transaction =>
            transaction.newDoc.length > MAX_COMMAND_LENGTH ? [] : transaction),
          EditorView.updateListener.of(update => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    editor.current = view;
    return () => { editor.current = null; view.destroy(); };
  }, []);

  useEffect(() => {
    const view = editor.current;
    if (view && value !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    editor.current?.dispatch({ effects: settings.current.reconfigure([
      placeholder(hint),
      EditorState.readOnly.of(disabled),
      EditorView.editable.of(!disabled),
      EditorView.contentAttributes.of({
        id, role: 'textbox', 'aria-label': label, 'aria-multiline': 'true',
        'aria-disabled': String(disabled), spellcheck: 'false', autocapitalize: 'off',
      }),
    ]) });
  }, [disabled, hint, id, label]);

  return <Input.Wrapper label={label} id={id} labelProps={{ onClick: () => editor.current?.focus() }}>
    <div ref={host} className="bash-editor" data-disabled={disabled || undefined} />
  </Input.Wrapper>;
}
