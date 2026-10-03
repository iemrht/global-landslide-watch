import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva('ui-button', {
  variants: {
    variant: {
      default: 'ui-button--default',
      outline: 'ui-button--outline',
      ghost: 'ui-button--ghost',
      danger: 'ui-button--danger',
    },
    size: {
      default: 'ui-button--md',
      sm: 'ui-button--sm',
      icon: 'ui-button--icon',
    },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});

function Button({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return <ButtonPrimitive className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { Button, buttonVariants };
