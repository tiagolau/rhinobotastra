import { memo } from 'react';
import { NodeProps } from 'reactflow';
import { BaseNode } from './BaseNode';

export const WaitReplyNode = memo((props: NodeProps) => {
  const getDescription = () => {
    const { variableName, timeoutValue, timeoutUnit } = props.data.config || {};

    const parts: string[] = [];

    if (variableName) {
      parts.push(`Salva em {${variableName}}`);
    }

    if (timeoutValue && timeoutUnit) {
      const labels: Record<string, string> = {
        hours: 'hora(s)',
        days: 'dia(s)',
      };
      parts.push(`Timeout: ${timeoutValue} ${labels[timeoutUnit] || timeoutUnit}`);
    }

    return parts.length > 0 ? parts.join(' · ') : 'Aguarda qualquer resposta';
  };

  return (
    <BaseNode
      {...props}
      icon="⏳"
      label="Aguardar Resposta"
      color="#f59e0b"
      description={getDescription()}
      onDelete={props.data.onDelete}
    />
  );
});

WaitReplyNode.displayName = 'WaitReplyNode';
