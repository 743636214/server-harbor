import React, { useEffect, useId, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
export function PasswordInput(props) {
  const [visible, setVisible] = useState(false),
    generatedId = useId();
  const id = props.id || generatedId;
  useEffect(() => {
    if (!props.value) setVisible(false);
  }, [props.value]);
  return (
    <span
      className="password-field password-control"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setVisible(false);
      }}
    >
      <input {...props} id={id} type={visible ? 'text' : 'password'} />
      <button
        type="button"
        title={visible ? '隐藏密码' : '显示密码'}
        aria-label={visible ? '隐藏密码' : '显示密码'}
        aria-controls={id}
        aria-pressed={visible}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setVisible((value) => !value)}
      >
        {visible ? <EyeOff size={15} /> : <Eye size={15} />}
        {visible ? '隐藏' : '显示'}
      </button>
    </span>
  );
}
