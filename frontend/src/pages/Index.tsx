import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Brain, Crosshair, Layers, Play } from 'lucide-react';
import heroImage from '@/assets/hero-medical.jpg';

const features = [
  {
    icon: Crosshair,
    title: 'Interactive Annotation',
    description: 'Add positive/negative points, bounding boxes, and polygons directly on video frames with precision tools.',
  },
  {
    icon: Brain,
    title: 'AI Segmentation',
    description: 'Leverage state-of-the-art models to generate accurate segmentation masks from your annotations.',
  },
  {
    icon: Layers,
    title: 'Object Tracking',
    description: 'Propagate masks across all video frames automatically for complete temporal analysis.',
  },
];

const Index = () => {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background">
      {/* Hero Section */}
      <section className="relative min-h-screen flex items-center justify-center overflow-hidden">
        {/* Background */}
        <div className="absolute inset-0">
          <img src={heroImage} alt="" className="w-full h-full object-cover opacity-30" />
          <div className="absolute inset-0 bg-gradient-to-b from-background/60 via-background/80 to-background" />
          <div className="absolute inset-0 bg-grid-pattern opacity-20" />
        </div>

        {/* Nav */}
        <nav className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-8 py-6">
          <div className="flex items-center gap-2">
            <Brain className="h-7 w-7 text-primary" />
            <span className="text-lg font-bold text-foreground">MedSeg Vision</span>
          </div>
          <Button variant="glow" size="sm" onClick={() => navigate('/workspace')}>
            Launch App
          </Button>
        </nav>

        {/* Hero Content */}
        <div className="relative z-10 text-center max-w-4xl mx-auto px-6">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: 'easeOut' }}
          >
            <div className="inline-flex items-center gap-2 px-4 py-1.5 mb-8 rounded-full border border-primary/30 bg-primary/5 text-primary text-sm font-medium">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
              </span>
              AI-Powered Medical Imaging
            </div>
            <h1 className="text-5xl md:text-7xl font-bold mb-6 leading-tight">
              <span className="text-foreground">Medical Video</span>
              <br />
              <span className="text-gradient-primary">Segmentation</span>
            </h1>
            <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto mb-10 leading-relaxed">
              Annotate, segment, and track objects in medical videos with precision. 
              Interactive tools powered by cutting-edge AI models.
            </p>
            <div className="flex items-center justify-center gap-4">
              <Button variant="glow" size="lg" onClick={() => navigate('/workspace')} className="text-base">
                <Play className="h-5 w-5" />
                Start Segmenting
              </Button>
              <Button variant="outline" size="lg" className="text-base">
                Learn More
              </Button>
            </div>
          </motion.div>
        </div>

        {/* Scroll indicator */}
        <motion.div
          className="absolute bottom-8 left-1/2 -translate-x-1/2"
          animate={{ y: [0, 8, 0] }}
          transition={{ duration: 2, repeat: Infinity }}
        >
          <div className="w-6 h-10 rounded-full border-2 border-muted-foreground/30 flex items-start justify-center p-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-primary" />
          </div>
        </motion.div>
      </section>

      {/* Features */}
      <section className="py-32 px-6">
        <div className="max-w-6xl mx-auto">
          <motion.div
            className="text-center mb-20"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
          >
            <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
              Powerful Segmentation Tools
            </h2>
            <p className="text-muted-foreground text-lg max-w-xl mx-auto">
              Everything you need for precise medical video analysis in one workspace.
            </p>
          </motion.div>

          <div className="grid md:grid-cols-3 gap-6">
            {features.map((feature, i) => (
              <motion.div
                key={feature.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: i * 0.15 }}
                className="group p-8 rounded-xl border border-border bg-card hover:border-primary/40 transition-all duration-300 hover:shadow-[0_0_30px_hsl(185_70%_42%/0.1)]"
              >
                <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center mb-5 group-hover:bg-primary/20 transition-colors">
                  <feature.icon className="h-6 w-6 text-primary" />
                </div>
                <h3 className="text-xl font-semibold text-foreground mb-3">{feature.title}</h3>
                <p className="text-muted-foreground leading-relaxed">{feature.description}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-8 px-6">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Brain className="h-4 w-4 text-primary" />
            MedSeg Vision
          </div>
          <p className="text-muted-foreground text-sm">AI-Powered Medical Video Segmentation</p>
        </div>
      </footer>
    </div>
  );
};

export default Index;
