import * as React from 'react';
import { Input as InputPrimitive } from '@base-ui/react/input';
import { cn } from '@/lib/utils';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return <InputPrimitive type={type} className={cn('ui-input', className)} {...props} />;
}

export { Input };
